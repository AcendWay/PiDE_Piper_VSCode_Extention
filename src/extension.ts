import * as vscode from "vscode";
import { createBridge } from "./bridge/server";
import { registerBridgeListeners } from "./bridge/listeners";
import type { Bridge } from "./bridge/server";
import {
	clearPiBinaryCache,
	findPiBinary,
	IS_WIN,
	upgradePi,
	winToWslPath,
} from "./pi";
import {
	buildFileContextLines,
	buildFileContextSummary,
	createPiTerminal,
	ensureTerminalAndSend,
	findPiTerminal,
	focusOrCreateTerminal,
	restartPiTerminal,
} from "./terminal";
import { ControlViewProvider, type FileStatus } from "./views/controlView";
import { DropzoneViewProvider } from "./views/dropzoneView";
import { SessionTracker } from "./sessions";
import { ModelsViewProvider } from "./views/modelsView";
import { PackagesViewProvider } from "./views/packagesView";
import { SessionsViewProvider } from "./views/sessionsView";

let bridge: Bridge | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let controlView: ControlViewProvider | undefined;
let dropzoneView: DropzoneViewProvider | undefined;
let sessionsView: SessionsViewProvider | undefined;
let packagesView: PackagesViewProvider | undefined;
let modelsView: ModelsViewProvider | undefined;
let sessionTracker: SessionTracker | undefined;

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	// ── Bridge ──────────────────────────────────────────────────────────────
	sessionTracker = new SessionTracker(context);
	bridge = await createBridge(context, (terminalId, sessionFile) => {
		sessionTracker?.track(terminalId, sessionFile);
	});

	// ── Bridge event listeners (notifications + selection cache) ────────────────
	registerBridgeListeners(context, bridge.state);

	// ── Sidebar views ────────────────────────────────────────────────────────
	controlView = new ControlViewProvider(context, bridge);
	dropzoneView = new DropzoneViewProvider(context);
	sessionsView = new SessionsViewProvider(context, bridge, sessionTracker);
	packagesView = new PackagesViewProvider(context, bridge);
	modelsView = new ModelsViewProvider(context, async (model) => {
		if (controlView) await controlView.applyModel(model);
		modelsView?.notifyCurrentModel(model);
	});

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ControlViewProvider.viewType,
			controlView,
		),
		vscode.window.registerWebviewViewProvider(
			DropzoneViewProvider.viewType,
			dropzoneView,
		),
		vscode.window.registerWebviewViewProvider(
			SessionsViewProvider.viewType,
			sessionsView,
		),
		vscode.window.registerWebviewViewProvider(
			PackagesViewProvider.viewType,
			packagesView,
		),
		vscode.window.registerWebviewViewProvider(
			ModelsViewProvider.viewType,
			modelsView,
		),
	);

	// ── Status bar button ────────────────────────────────────────────────────
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	statusBarItem.text = "$(terminal) π Pi";
	statusBarItem.tooltip = "Open Pi Agent terminal (Ctrl+Alt+P)";
	statusBarItem.command = "piSidebar.open";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// ── Terminal profile ─────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.window.registerTerminalProfileProvider("piSidebar.terminalProfile", {
			provideTerminalProfile() {
				if (!bridge) return undefined;
				const piPath = findPiBinary();
				const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				// On Windows, pi lives in WSL2 — profile must use wsl.exe
				// and the WSL-accessible bridge URL.
				const shellPath = IS_WIN ? "wsl.exe" : piPath;
				const shellArgs = IS_WIN
					? ["--cd", winToWslPath(workspaceCwd ?? "/"), "--", piPath]
					: undefined;
				return new vscode.TerminalProfile({
					name: "Pi Agent",
					shellPath,
					shellArgs,
					env: {
						PI_VSCODE_BRIDGE_URL: bridge.wslUrl,
						PI_VSCODE_BRIDGE_TOKEN: bridge.token,
					},
					cwd: workspaceCwd,
					iconPath: {
						light: vscode.Uri.joinPath(
							context.extensionUri,
							"media",
							"pi-logo-light.svg",
						),
						dark: vscode.Uri.joinPath(
							context.extensionUri,
							"media",
							"pi-logo-dark.svg",
						),
					},
				});
			},
		}),
	);

	// ── Commands ─────────────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand("piSidebar.open", async () => {
			if (!bridge) return;
			await focusOrCreateTerminal(bridge, context.extensionUri);
			await revealSidebar();
		}),

		vscode.commands.registerCommand("piSidebar.openWithFile", async () => {
			if (!bridge) return;
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage("Pi: No active editor.");
				return;
			}
			const existing = findPiTerminal();
			if (existing) {
				// Terminal already running — send context as a message
				const summary = buildFileContextSummary();
				existing.show(true);
				existing.sendText(summary, true);
			} else {
				// No terminal — start fresh with file context in system prompt
				const contextLines = buildFileContextLines();
				await createPiTerminal(bridge, context.extensionUri, { contextLines });
			}
		}),

		vscode.commands.registerCommand("piSidebar.sendSelection", async () => {
			if (!bridge) return;
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage("Pi: No active editor.");
				return;
			}
			// Use selected text if available, otherwise send file context summary
			const text = editor.selection.isEmpty
				? buildFileContextSummary()
				: editor.document.getText(editor.selection);
			if (!text.trim()) {
				vscode.window.showWarningMessage("Pi: Nothing to send.");
				return;
			}
			await ensureTerminalAndSend(text, bridge, context.extensionUri);
		}),

		vscode.commands.registerCommand("piSidebar.reviewDiffs", async () => {
			if (!bridge) return;
			const prompt =
				"Review the current git diffs. Use vscode_context with includeDiff=true, then inspect changed files as needed.";
			await ensureTerminalAndSend(prompt, bridge, context.extensionUri);
		}),

		vscode.commands.registerCommand("piSidebar.restart", async () => {
			if (!bridge) return;
			await restartPiTerminal(bridge, context.extensionUri);
			// onDidOpenTerminal will flip the dot back to running — but if
			// the close event is in flight, force a re-check too.
			setTimeout(() => {
				controlView?.notifyTerminalState(!!findPiTerminal());
			}, 250);
		}),

		vscode.commands.registerCommand("piSidebar.newSession", async () => {
			if (!bridge) return;
			// Force a brand-new terminal with no session file
			await createPiTerminal(bridge, context.extensionUri);
		}),

		vscode.commands.registerCommand("piSidebar.selectModel", async () => {
			if (!bridge) return;
			const models = controlView?.buildQuickPickModels() ?? commonModels();
			const model = await vscode.window.showQuickPick(models, {
				placeHolder: "Select a model for Pi (will restart terminal)",
			});
			if (!model) return;
			// applyModel is handled inside controlView; if the view isn't
			// open we replicate the logic here.
			if (controlView) {
				await (controlView as any).applyModel(model);
			} else {
				const cfg = vscode.workspace.getConfiguration("piSidebar");
				await cfg.update(
					"defaultModel",
					model,
					vscode.ConfigurationTarget.Global,
				);
				await restartPiTerminal(bridge, context.extensionUri);
			}
		}),

		vscode.commands.registerCommand("piSidebar.upgrade", async () => {
			await upgradePi();
		}),
	);

	// ── Config change listener ───────────────────────────────────────────────
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("piSidebar.piExecutable")) {
				clearPiBinaryCache();
			}
		}),
	);

	// ── Terminal close listener ──────────────────────────────────────────────
	context.subscriptions.push(
		vscode.window.onDidOpenTerminal((terminal) => {
			if (
				terminal.name === "Pi Agent" ||
				terminal.name.startsWith("Pi Agent")
			) {
				controlView?.notifyTerminalState(true);
				dropzoneView?.notifyTerminalState(true);
			}
		}),
		vscode.window.onDidCloseTerminal((terminal) => {
			if (
				terminal.name === "Pi Agent" ||
				terminal.name.startsWith("Pi Agent")
			) {
				sessionTracker?.onClose(terminal);
				setTimeout(() => {
					const running = !!findPiTerminal();
					controlView?.notifyTerminalState(running);
					dropzoneView?.notifyTerminalState(running);
				}, 250);
			}
		}),
	);

	// ── File status → control panel live updates ─────────────────────
	const pushFileStatus = () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			controlView?.notifyFileStatus(null);
			return;
		}
		const diag = vscode.languages.getDiagnostics(editor.document.uri);
		let errors = 0;
		let warnings = 0;
		for (const d of diag) {
			if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
			else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
		}
		const status: FileStatus = {
			filePath: vscode.workspace.asRelativePath(editor.document.uri),
			languageId: editor.document.languageId,
			cursor: `${editor.selection.active.line + 1}:${editor.selection.active.character + 1}`,
			isDirty: editor.document.isDirty,
			errors,
			warnings,
		};
		controlView?.notifyFileStatus(status);
	};

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => pushFileStatus()),
		vscode.window.onDidChangeTextEditorSelection(() => pushFileStatus()),
		vscode.languages.onDidChangeDiagnostics(() => pushFileStatus()),
		vscode.workspace.onDidChangeTextDocument(() => pushFileStatus()),
	);
	pushFileStatus(); // seed on startup

	// ── Restore sessions from previous VS Code window ──────────────────
	const piSidebarCfg = vscode.workspace.getConfiguration("piSidebar");
	if (piSidebarCfg.get<boolean>("restoreSessions", true)) {
		try {
			await sessionTracker.restore(bridge, context.extensionUri);
		} catch (err) {
			console.error("Pi: session restore failed", err);
		}
	}

	// ── Auto-start a Pi terminal on activation if none exists ───────────────
	if (!findPiTerminal() && piSidebarCfg.get<boolean>("autoStart", true)) {
		try {
			await createPiTerminal(bridge, context.extensionUri);
			controlView?.notifyTerminalState(true);
		} catch (err) {
			console.error("Pi: auto-start failed", err);
		}
	}

	// Push active sessions to sessions view whenever they change
	const refreshActiveSessions = () => {
		const tracked =
			sessionTracker?.getSessions().map((s) => s.sessionFile) ?? [];
		sessionsView?.setActiveSessions(tracked);
	};
	context.subscriptions.push(
		vscode.window.onDidOpenTerminal(() =>
			setTimeout(refreshActiveSessions, 500),
		),
		vscode.window.onDidCloseTerminal(() =>
			setTimeout(refreshActiveSessions, 500),
		),
	);

	// ── Show sidebar on startup if configured ────────────────────────────────
	const cfg = vscode.workspace.getConfiguration("piSidebar");
	if (cfg.get<boolean>("showOnStartup", true)) {
		await revealSidebar();
	}
}

export async function deactivate(): Promise<void> {
	// Dispose Pi terminals
	for (const t of vscode.window.terminals) {
		if (t.name === "Pi Agent") t.dispose();
	}
	await bridge?.dispose();
	bridge = undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function revealSidebar(): Promise<void> {
	await vscode.commands.executeCommand("workbench.view.extension.piSidebar");
}

function commonModels(): string[] {
	return [
		"claude-sonnet-4",
		"claude-opus-4",
		"claude-haiku-3-5",
		"gemini-2.5-pro",
		"gemini-2.5-flash",
		"gpt-4o",
		"gpt-4o-mini",
		"o3",
		"o4-mini",
	];
}

/** Exported so views can get the current bridge/terminal handle. */
export function getActivePiTerminal(): vscode.Terminal | undefined {
	return findPiTerminal();
}
