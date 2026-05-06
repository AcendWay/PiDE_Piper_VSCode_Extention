import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";
import * as pty from "node-pty";
import * as vscode from "vscode";

type BridgeRequest = { token: string; action: string; payload?: any };
type PtyProcess = pty.IPty;

const IS_WIN = process.platform === "win32";

/** Convert a Windows absolute path to its /mnt/<drive>/... WSL equivalent. */
function winToWslPath(winPath: string): string {
	return winPath
		.replace(/\\/g, "/")
		.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

/**
 * When the extension runs on the Windows host (not in WSL Remote), pi lives
 * inside WSL2. We spawn `wsl.exe` and the pi process needs to reach the bridge
 * server that is listening on the Windows host. In WSL2 NAT mode the Windows
 * host is reachable at the nameserver address in /etc/resolv.conf.
 * In mirrored-networking mode 127.0.0.1 also works, so we try resolv.conf
 * first and fall back to 127.0.0.1.
 */
function getWslHostIp(): string {
	try {
		const out = child_process.execSync("wsl.exe cat /etc/resolv.conf", {
			encoding: "utf8",
			timeout: 3000,
		});
		const m = out.match(/nameserver\s+([\d.]+)/);
		if (m) return m[1];
	} catch {
		// ignore
	}
	return "127.0.0.1";
}

let provider: PiSidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	provider = new PiSidebarProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			PiSidebarProvider.viewType,
			provider,
		),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("piSidebar.open", () => revealPiView()),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("piSidebar.restart", () =>
			provider?.restart(),
		),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("piSidebar.sendSelection", () =>
			provider?.sendEditorContext(),
		),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("piSidebar.reviewDiffs", async () => {
			await revealPiView();
			provider?.sendText(
				"Review the current git diffs. Use vscode_context includeDiff=true, then inspect changed files as needed.\r",
			);
		}),
	);

	if (
		vscode.workspace
			.getConfiguration("piSidebar")
			.get<boolean>("showOnStartup", true)
	) {
		void revealPiView();
	}
}

async function revealPiView() {
	await vscode.commands.executeCommand("workbench.view.extension.piSidebar");
	await vscode.commands.executeCommand("piSidebar.session.focus");
}

export function deactivate() {
	provider?.dispose();
}

class PiSidebarProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	static readonly viewType = "piSidebar.session";

	private view?: vscode.WebviewView;
	private proc?: PtyProcess;
	private bridge?: net.Server;
	private bridgePort = 0;
	/** On Windows the bridge binds 0.0.0.0; the WSL process uses the host IP. */
	private bridgeHost = "127.0.0.1";
	private readonly bridgeToken = crypto.randomBytes(24).toString("hex");
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.startBridge();
	}

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		const webview = view.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, "media"),
				vscode.Uri.joinPath(this.context.extensionUri, "node_modules"),
			],
		};
		webview.html = this.html(webview);
		webview.onDidReceiveMessage(
			(message) => this.handleWebviewMessage(message),
			undefined,
			this.disposables,
		);

		if (
			vscode.workspace
				.getConfiguration("piSidebar")
				.get<boolean>("autoStart", true)
		) {
			this.start();
		}
	}

	dispose() {
		this.proc?.kill();
		this.bridge?.close();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	restart() {
		this.proc?.kill();
		this.proc = undefined;
		this.post({ type: "clear" });
		this.start();
	}

	sendText(text: string) {
		this.proc?.write(text);
	}

	async sendEditorContext() {
		const text = await this.buildEditorPrompt();
		this.sendText(text + "\r");
	}

	private start() {
		if (this.proc || !this.view || !this.bridgePort) return;

		const cfg = vscode.workspace.getConfiguration("piSidebar");
		const piExecutable = cfg.get<string>("piExecutable", "pi");
		const startupArgs = cfg.get<string[]>("startupArgs", []);
		const initialPrompt = cfg.get<string>("initialPrompt", "");
		const workspace =
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

		// The piVscodeTools.js path needs to be a path that pi (running on Linux)
		// can load. When the extension host is on Windows, extensionPath is a
		// Windows path; convert it to a WSL /mnt/… path.
		const extPathNative = path.join(
			this.context.extensionPath,
			"src",
			"piVscodeTools.js",
		);
		const piToolsPath = IS_WIN ? winToWslPath(extPathNative) : extPathNative;

		const piArgs = ["--extension", piToolsPath, ...startupArgs];
		if (initialPrompt.trim()) piArgs.push(this.decoratePrompt(initialPrompt));

		const env: NodeJS.ProcessEnv = {
			...process.env,
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			PI_VSCODE_BRIDGE_PORT: String(this.bridgePort),
			PI_VSCODE_BRIDGE_TOKEN: this.bridgeToken,
			PI_VSCODE_BRIDGE_HOST: this.bridgeHost,
		};

		let spawnFile: string;
		let spawnArgs: string[];
		let spawnCwd: string;

		if (IS_WIN) {
			// pi lives in WSL2; spawn it via wsl.exe.
			// Convert Windows workspace path to WSL path for --cd.
			const wslCwd = winToWslPath(workspace);
			spawnFile = "wsl.exe";
			spawnArgs = ["--cd", wslCwd, "--", piExecutable, ...piArgs];
			// wsl.exe inherits Windows env; some vars confuse Linux tools. Strip them.
			delete env.TERM_PROGRAM;
			delete env.ConEmuPID;
			spawnCwd = workspace; // node-pty cwd stays as Windows path
		} else {
			spawnFile = piExecutable;
			spawnArgs = piArgs;
			spawnCwd = workspace;
		}

		try {
			this.proc = pty.spawn(spawnFile, spawnArgs, {
				name: "xterm-256color",
				cols: 100,
				rows: 32,
				cwd: spawnCwd,
				env,
			});
		} catch (err: any) {
			vscode.window.showErrorMessage(
				`Pi Sidebar: failed to start — ${err?.message ?? err}`,
			);
			return;
		}

		this.proc.onData((data) => this.post({ type: "data", data }));
		this.proc.onExit(({ exitCode, signal }) => {
			this.post({ type: "exit", exitCode, signal });
			this.proc = undefined;
		});
		this.post({
			type: "status",
			text: `Pi running in ${workspace}${IS_WIN ? " (via wsl.exe)" : ""}`,
		});
	}

	private handleWebviewMessage(message: any) {
		if (message.type === "ready") this.start();
		if (message.type === "input" && typeof message.data === "string")
			this.proc?.write(message.data);
		if (message.type === "resize" && this.proc)
			this.proc.resize(
				Math.max(20, message.cols | 0),
				Math.max(6, message.rows | 0),
			);
		if (message.type === "restart") this.restart();
		if (message.type === "sendSelection") void this.sendEditorContext();
	}

	private post(message: any) {
		void this.view?.webview.postMessage(message);
	}

	private decoratePrompt(prompt: string): string {
		const folder =
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
			"No workspace folder";
		const active = vscode.window.activeTextEditor;
		const activePath = active
			? vscode.workspace.asRelativePath(active.document.uri)
			: "No active editor";
		const platform = IS_WIN ? "Windows (WSL2 pi)" : "Linux/WSL";
		return (
			`${prompt}\n\n` +
			`VS Code startup context:\n` +
			`- Platform: ${platform}\n` +
			`- Workspace: ${folder}\n` +
			`- Active editor: ${activePath}\n` +
			`- Bridge tools available: vscode_context, vscode_open_file, vscode_show_diff, vscode_command`
		);
	}

	private async buildEditorPrompt(): Promise<string> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return "No active editor in VS Code.";
		const doc = editor.document;
		const rel = vscode.workspace.asRelativePath(doc.uri);
		const selection = editor.selection.isEmpty
			? ""
			: doc.getText(editor.selection);
		const cursor = `${editor.selection.active.line + 1}:${editor.selection.active.character + 1}`;
		const selected = selection
			? `\nSelected text:\n\n\`\`\`\n${selection}\n\`\`\``
			: "";
		return `VS Code editor context:\n- File: ${rel}\n- Cursor: ${cursor}\n- Language: ${doc.languageId}${selected}\nUse this context for the next answer.`;
	}

	private startBridge() {
		// On Windows the bridge must be reachable from WSL2, so bind to all
		// interfaces (0.0.0.0) and tell pi which host IP to connect to.
		const bindHost = IS_WIN ? "0.0.0.0" : "127.0.0.1";
		if (IS_WIN) {
			this.bridgeHost = getWslHostIp();
		}

		this.bridge = net.createServer((socket) => {
			let raw = "";
			socket.on("data", (chunk) => {
				raw += chunk.toString("utf8");
				if (raw.includes("\n")) {
					const line = raw.slice(0, raw.indexOf("\n"));
					void this.handleBridgeLine(line).then(
						(result) => socket.end(JSON.stringify({ ok: true, result })),
						(error) =>
							socket.end(
								JSON.stringify({
									ok: false,
									error: String(error?.message ?? error),
								}),
							),
					);
				}
			});
		});

		this.bridge.listen(0, bindHost, () => {
			const addr = this.bridge?.address();
			if (addr && typeof addr === "object") this.bridgePort = addr.port;
			if (
				this.view &&
				vscode.workspace
					.getConfiguration("piSidebar")
					.get<boolean>("autoStart", true)
			) {
				this.start();
			}
		});
	}

	private async handleBridgeLine(line: string): Promise<string> {
		const req = JSON.parse(line) as BridgeRequest;
		if (req.token !== this.bridgeToken)
			throw new Error("Invalid VS Code bridge token");
		switch (req.action) {
			case "context":
				return this.getContext(req.payload);
			case "openFile":
				return this.openFile(req.payload);
			case "showDiff":
				return this.showDiff(req.payload);
			case "command":
				return this.executeCommand(req.payload);
			default:
				throw new Error(`Unknown VS Code bridge action: ${req.action}`);
		}
	}

	private async getContext(payload: any): Promise<string> {
		const active = vscode.window.activeTextEditor;
		const visible = vscode.window.visibleTextEditors.map((e) =>
			vscode.workspace.asRelativePath(e.document.uri),
		);
		const diagnostics = payload?.includeDiagnostics
			? vscode.languages
					.getDiagnostics()
					.flatMap(([uri, ds]) =>
						ds.slice(0, 20).map((d) => ({
							file: vscode.workspace.asRelativePath(uri),
							line: d.range.start.line + 1,
							severity: d.severity,
							message: d.message,
						})),
					)
					.slice(0, 200)
			: undefined;
		const diff = payload?.includeDiff ? await this.gitSummary() : undefined;
		return JSON.stringify(
			{
				workspaceFolders:
					vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
				activeEditor: active
					? {
							file: vscode.workspace.asRelativePath(active.document.uri),
							language: active.document.languageId,
							cursor: [
								active.selection.active.line + 1,
								active.selection.active.character + 1,
							],
							selectedText: active.selection.isEmpty
								? ""
								: active.document.getText(active.selection),
						}
					: null,
				visibleEditors: visible,
				diagnostics,
				diff,
			},
			null,
			2,
		);
	}

	private async openFile(payload: any): Promise<string> {
		const uri = this.resolveUri(payload?.path);
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc, {
			preview: false,
		});
		if (payload?.line) {
			const pos = new vscode.Position(
				Math.max(0, payload.line - 1),
				Math.max(0, (payload.column ?? 1) - 1),
			);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(
				new vscode.Range(pos, pos),
				vscode.TextEditorRevealType.InCenter,
			);
		}
		return `Opened ${vscode.workspace.asRelativePath(uri)}`;
	}

	private async showDiff(payload: any): Promise<string> {
		if (payload?.left && payload?.right) {
			await vscode.commands.executeCommand(
				"vscode.diff",
				this.resolveUri(payload.left),
				this.resolveUri(payload.right),
				payload.title ?? "Diff",
			);
			return "Opened explicit diff";
		}
		if (!payload?.path) throw new Error("showDiff requires path or left/right");
		const file = this.resolveUri(payload.path);
		const left = file.with({
			scheme: "git",
			query: JSON.stringify({ path: file.fsPath, ref: "HEAD" }),
		});
		await vscode.commands.executeCommand(
			"vscode.diff",
			left,
			file,
			payload.title ?? `${vscode.workspace.asRelativePath(file)} ↔ HEAD`,
		);
		return `Opened diff for ${vscode.workspace.asRelativePath(file)}`;
	}

	private async executeCommand(payload: any): Promise<string> {
		const args = payload?.argsJson ? JSON.parse(payload.argsJson) : [];
		const result = await vscode.commands.executeCommand(
			payload.command,
			...args,
		);
		return typeof result === "undefined"
			? `Executed ${payload.command}`
			: JSON.stringify(result, null, 2);
	}

	private resolveUri(input: string): vscode.Uri {
		if (!input) throw new Error("Missing path");
		if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return vscode.Uri.parse(input);
		if (path.isAbsolute(input)) return vscode.Uri.file(input);
		const folder =
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		return vscode.Uri.file(path.join(folder, input));
	}

	private async gitSummary(): Promise<string> {
		const git = vscode.extensions
			.getExtension("vscode.git")
			?.exports?.getAPI?.(1);
		const repo = git?.repositories?.[0];
		if (!repo) return "VS Code Git API unavailable or no repository open.";
		const changes = [
			...repo.state.workingTreeChanges,
			...repo.state.indexChanges,
		].map((c: any) => ({
			uri: vscode.workspace.asRelativePath(c.uri),
			status: c.status,
		}));
		return JSON.stringify({ branch: repo.state.HEAD?.name, changes }, null, 2);
	}

	private html(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString("hex");
		const uri = (...parts: string[]) =>
			webview.asWebviewUri(
				vscode.Uri.joinPath(this.context.extensionUri, ...parts),
			);
		return `<!doctype html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${uri("node_modules", "@xterm", "xterm", "css", "xterm.css")}">
<link rel="stylesheet" href="${uri("media", "styles.css")}">
</head><body>
<header><strong>π Pi</strong><span id="status">booting…</span><button id="selection">context</button><button id="restart">restart</button></header>
<main id="terminal"></main>
<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "xterm", "lib", "xterm.js")}"></script>
<script nonce="${nonce}" src="${uri("node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js")}"></script>
<script nonce="${nonce}" src="${uri("media", "main.js")}"></script>
</body></html>`;
	}
}
