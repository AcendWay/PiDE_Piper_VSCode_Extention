import * as path from "node:path";
import * as vscode from "vscode";
import {
	buildPiArgs,
	buildPiEnv,
	ensurePiBinary,
	IS_WIN,
	winToWslPath,
} from "./pi";

export const TERMINAL_NAME = "Pi Agent";

/**
 * Find an existing Pi terminal in the current window.
 * Returns the terminal if found, undefined otherwise.
 */
export function findPiTerminal(): vscode.Terminal | undefined {
	return vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
}

/**
 * Focus an existing Pi terminal, or create a new one.
 * Returns the terminal that was focused or created.
 */
export async function focusOrCreateTerminal(
	bridgeConfig: { url: string; wslUrl: string; token: string },
	extensionUri: vscode.Uri,
	options: {
		sessionFile?: string;
		model?: string;
		extraArgs?: string[];
		contextLines?: string[];
	} = {},
): Promise<vscode.Terminal | undefined> {
	// Reuse existing Pi terminal if one is running and no specific session/model requested
	if (!options.sessionFile && !options.model && !options.extraArgs?.length) {
		const existing = findPiTerminal();
		if (existing) {
			existing.show(true);
			return existing;
		}
	}
	return createPiTerminal(bridgeConfig, extensionUri, options);
}

/**
 * Create a brand-new Pi terminal.
 */
export async function createPiTerminal(
	bridgeConfig: { url: string; wslUrl: string; token: string },
	extensionUri: vscode.Uri,
	options: {
		sessionFile?: string;
		model?: string;
		extraArgs?: string[];
		contextLines?: string[];
	} = {},
): Promise<vscode.Terminal | undefined> {
	const piPath = await ensurePiBinary();
	if (!piPath) return undefined;

	const cfg = vscode.workspace.getConfiguration("piSidebar");
	const workspaceRoot =
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

	// Path to the bridge extension JS file that pi loads via --extension
	const bridgeExtNative = path.join(
		extensionUri.fsPath,
		"src",
		"bridge-extension",
		"piVscodeTools.js",
	);

	const model =
		options.model ?? (cfg.get<string>("defaultModel", "") || undefined);

	// Build pi args (WSL-aware path conversion happens inside if IS_WIN)
	const bridgeExtPath = IS_WIN
		? winToWslPath(bridgeExtNative)
		: bridgeExtNative;
	const piArgs = buildPiArgs({
		bridgeExtensionPath: bridgeExtPath,
		model,
		sessionFile: options.sessionFile,
		extraArgs: options.extraArgs,
	});

	// Inject context lines as a one-shot system prompt addition
	if (options.contextLines?.length) {
		piArgs.push("--append-system-prompt", options.contextLines.join("\n\n"));
	}

	const env = buildPiEnv(bridgeConfig);

	let shellPath: string;
	let shellArgs: string[];
	let cwd: string;

	if (IS_WIN) {
		// pi lives in WSL2 — spawn via wsl.exe
		const wslCwd = winToWslPath(workspaceRoot);
		shellPath = "wsl.exe";
		shellArgs = ["--cd", wslCwd, "--", piPath, ...piArgs];
		cwd = workspaceRoot; // node cwd stays as Windows path
	} else {
		shellPath = piPath;
		shellArgs = piArgs;
		cwd = workspaceRoot;
	}

	const location = resolveTerminalLocation(
		cfg.get<string>("terminalLocation", "beside"),
	);

	const terminal = vscode.window.createTerminal({
		name: TERMINAL_NAME,
		shellPath,
		shellArgs,
		cwd,
		env,
		location,
		isTransient: false,
		iconPath: {
			light: vscode.Uri.joinPath(extensionUri, "media", "pi-logo-light.svg"),
			dark: vscode.Uri.joinPath(extensionUri, "media", "pi-logo-dark.svg"),
		},
	});

	terminal.show(true);
	return terminal;
}

/**
 * Kill the running Pi terminal (if any) and start a fresh one.
 */
export async function restartPiTerminal(
	bridgeConfig: { url: string; wslUrl: string; token: string },
	extensionUri: vscode.Uri,
): Promise<vscode.Terminal | undefined> {
	const existing = findPiTerminal();
	if (existing) {
		existing.dispose();
		// Small delay to let VS Code clean up
		await new Promise<void>((r) => setTimeout(r, 200));
	}
	return createPiTerminal(bridgeConfig, extensionUri);
}

/**
 * Send text to the running Pi terminal (if one exists).
 * @param addNewline - append \r to submit the input (default true)
 */
export function sendTextToTerminal(
	text: string,
	addNewline = true,
): boolean {
	const terminal = findPiTerminal();
	if (!terminal) return false;
	terminal.show(true);
	terminal.sendText(text, addNewline);
	return true;
}

/**
 * Ensure a Pi terminal exists, then send text once it is ready.
 * If the terminal already exists the text is sent immediately.
 * If a new terminal is being created we wait for it to signal readiness
 * via a brief poll (VS Code doesn't expose an "onReady" event for terminals).
 */
export async function ensureTerminalAndSend(
	text: string,
	bridgeConfig: { url: string; wslUrl: string; token: string },
	extensionUri: vscode.Uri,
	addNewline = true,
): Promise<void> {
	const existing = findPiTerminal();
	if (existing) {
		existing.show(true);
		existing.sendText(text, addNewline);
		return;
	}

	// Terminal doesn't exist — create it, then send after a startup delay.
	// We use a longer delay for a fresh terminal so pi's TUI has time to
	// initialise before receiving input.
	const terminal = await createPiTerminal(bridgeConfig, extensionUri);
	if (!terminal) return;
	await new Promise<void>((r) => setTimeout(r, 1500));
	terminal.sendText(text, addNewline);
}

/**
 * Build context lines for the active editor state.
 * Used both for --append-system-prompt (new terminal) and
 * for sending context mid-session to an existing terminal.
 */
export function buildFileContextLines(): string[] {
	const lines: string[] = [];
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (workspaceRoot) lines.push(`The workspace root is: ${workspaceRoot}`);

	const editor = vscode.window.activeTextEditor;
	if (!editor) return lines;

	const fileName = editor.document.fileName;
	const selection = editor.selection;

	if (selection.isEmpty) {
		lines.push(`The user is currently viewing: ${fileName}`);
		lines.push(
			`Cursor is at line ${selection.active.line + 1}, character ${
				selection.active.character + 1
			}.`,
		);
	} else {
		const text = editor.document.getText(selection);
		lines.push(`The user is currently viewing: ${fileName}`);
		lines.push(
			`Selected lines ${selection.start.line + 1}–${selection.end.line + 1}:`,
		);
		lines.push(`\`\`\`${editor.document.languageId}\n${text}\n\`\`\``);
	}

	return lines;
}

/**
 * Build a compact single-line context summary for sending to a running session.
 * e.g. "File: src/foo.ts | Cursor: 42:5 | Selection: lines 40-45"
 */
export function buildFileContextSummary(): string {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return "No active editor.";

	const rel = vscode.workspace.asRelativePath(editor.document.uri);
	const { active, start, end, isEmpty } = editor.selection;
	const cursor = `${active.line + 1}:${active.character + 1}`;
	const lang = editor.document.languageId;
	const dirty = editor.document.isDirty ? " (unsaved)" : "";

	if (isEmpty) {
		return `File context: ${rel} | Language: ${lang} | Cursor: ${cursor}${dirty}`;
	}

	const selectedText = editor.document.getText(editor.selection);
	return (
		`File context: ${rel} | Language: ${lang} | ` +
		`Selection lines ${start.line + 1}–${end.line + 1}${dirty}:\n` +
		`\`\`\`${lang}\n${selectedText}\n\`\`\``
	);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveTerminalLocation(
	setting: string,
):
	| vscode.TerminalEditorLocationOptions
	| vscode.TerminalSplitLocationOptions
	| undefined {
	switch (setting) {
		case "panel":
			return undefined; // default VS Code behaviour = bottom panel
		case "active":
			return {
				viewColumn: vscode.ViewColumn.Active,
				preserveFocus: true,
			};
		case "beside":
		default:
			return {
				viewColumn: findNextColumn(),
				preserveFocus: true,
			};
	}
}

/**
 * Find the column the existing Pi terminal lives in, or pick the next unused column.
 */
function findNextColumn(): vscode.ViewColumn {
	// Prefer reusing the existing pi terminal column
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (
				tab.input instanceof vscode.TabInputTerminal &&
				tab.label === TERMINAL_NAME
			) {
				return group.viewColumn;
			}
		}
	}
	// Find an unused column
	const used = new Set(vscode.window.tabGroups.all.map((g) => g.viewColumn));
	for (let col = vscode.ViewColumn.One; col <= vscode.ViewColumn.Nine; col++) {
		if (!used.has(col)) return col;
	}
	return vscode.ViewColumn.Beside;
}
