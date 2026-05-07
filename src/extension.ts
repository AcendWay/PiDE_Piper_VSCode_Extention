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
import { ControlViewProvider } from "./views/controlView";
import { PackagesViewProvider } from "./views/packagesView";
import { SessionsViewProvider } from "./views/sessionsView";

let bridge: Bridge | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let controlView: ControlViewProvider | undefined;
let sessionsView: SessionsViewProvider | undefined;
let packagesView: PackagesViewProvider | undefined;

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	// ── Bridge ──────────────────────────────────────────────────────────────
	bridge = await createBridge(context, (terminalId, sessionFile) => {
		// Will be wired to session tracker in Phase 3 (#10)
		void terminalId;
		void sessionFile;
	});

	// ── Bridge event listeners (notifications + selection cache) ────────────────
	registerBridgeListeners(context, bridge.state);

	// ── Sidebar views ────────────────────────────────────────────────────────
	controlView = new ControlViewProvider(context, bridge);
	sessionsView = new SessionsViewProvider(context);
	packagesView = new PackagesViewProvider(context, bridge);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ControlViewProvider.viewType,
			controlView,
		),
		vscode.window.registerWebviewViewProvider(
			SessionsViewProvider.viewType,
			sessionsView,
		),
		vscode.window.registerWebviewViewProvider(
			PackagesViewProvider.viewType,
			packagesView,
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
			controlView?.notifyTerminalState(false);
		}),

		vscode.commands.registerCommand("piSidebar.newSession", async () => {
			if (!bridge) return;
			// Force a brand-new terminal with no session file
			await createPiTerminal(bridge, context.extensionUri);
		}),

		vscode.commands.registerCommand("piSidebar.selectModel", async () => {
			// Delegated to the control view's model picker (Phase 2, #7)
			// For now, show a quick pick with common models
			const model = await vscode.window.showQuickPick(commonModels(), {
				placeHolder: "Select a model for Pi",
			});
			if (!model || !bridge) return;
			const cfg = vscode.workspace.getConfiguration("piSidebar");
			await cfg.update(
				"defaultModel",
				model,
				vscode.ConfigurationTarget.Global,
			);
			await restartPiTerminal(bridge, context.extensionUri);
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
		vscode.window.onDidCloseTerminal((terminal) => {
			if (terminal.name === "Pi Agent") {
				controlView?.notifyTerminalState(false);
			}
		}),
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
