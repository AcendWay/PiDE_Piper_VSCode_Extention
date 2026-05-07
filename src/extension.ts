import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { transition, INITIAL_SNAPSHOT } from "./agentStateMachine";
import { buildTabName, DEFAULT_PALETTE } from "./tabPalette";
import type { AgentEvent } from "./agentStateMachine";
import { upsertTab } from "./bridge/state";
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
	findAllPiTerminals,
	findPiTerminal,
	focusOrCreateTerminal,
	restartPiTerminal,
	setLastFocusedTerminalId,
	TERMINAL_NAME,
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
/** Maps PI_VSCODE_TERMINAL_ID → vscode.Terminal, populated when each terminal opens. */
const terminalMap = new Map<string, vscode.Terminal>();
/** Map terminal object → its terminalId (reverse lookup). */
const terminalIdMap = new WeakMap<vscode.Terminal, string>();
/** Tracks pending grace-period timers for tab cleanup after terminal close. */
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Tracks idle → clear timers per terminalId. */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Per-terminal state machine snapshots (used for idle timer management). */
const stateMachineSnapshots = new Map<string, import("./agentStateMachine").StateMachineSnapshot>();
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

	// ── Bridge onTabUpdated callback ───────────────────────────────────
	// Fired from bridge handlers when a tab's state changes.
	bridge.state.onTabUpdated = (terminalId, modelFallback) => {
		const tab = bridge!.state.tabs.get(terminalId);
		if (!tab) return;

		// ── Idle timer management ─────────────────────────────────────────
		// Apply the state machine transition for the new agent state,
		// managing idle → clear timers based on the result.
		if (tab.agentState) {
			applyAgentStateMachine(terminalId, tab.agentState);
		}

		// Push updated tab list to the webview
		controlView?.notifyTabsChanged(
			bridge!.state.tabs.toArray(),
			bridge!.state.currentTerminalId,
		);

		// ── Model confirmed ───────────────────────────────────────────────
		if (tab.model && modelFallback !== undefined) {
			controlView?.notifyModelChanged(tab.model);
			vscode.workspace
				.getConfiguration("piSidebar")
				.update("defaultModel", tab.model, vscode.ConfigurationTarget.Global)
				.then(undefined, (e) => console.error("Pi: failed to persist model", e));
			if (modelFallback) {
				vscode.window.setStatusBarMessage(
					`$(warning) Pi: model switch fell back to /model ${tab.model}`,
					4000,
				);
			} else {
				vscode.window.setStatusBarMessage(
					`$(check) Pi model switched to ${tab.model}`,
					4000,
				);
			}
		}
	};

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
			const res = await focusOrCreateTerminal(bridge, context.extensionUri);
			if (res) registerPiTerminal(res.terminal, res.terminalId);
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
				const res2 = await createPiTerminal(bridge, context.extensionUri, {
					contextLines,
				});
				if (res2) registerPiTerminal(res2.terminal, res2.terminalId);
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
			const restartRes = await restartPiTerminal(bridge, context.extensionUri);
			if (restartRes)
				registerPiTerminal(restartRes.terminal, restartRes.terminalId);
			// onDidOpenTerminal will flip the dot back to running — but if
			// the close event is in flight, force a re-check too.
			setTimeout(() => {
				controlView?.notifyTerminalState(!!findPiTerminal());
			}, 250);
		}),

		vscode.commands.registerCommand("piSidebar.newSession", async () => {
			// Legacy alias — delegate to newTab
			await vscode.commands.executeCommand("piSidebar.newTab");
		}),

		vscode.commands.registerCommand("piSidebar.newTab", async () => {
			if (!bridge) return;
			// Ask for an optional label
			const label = await vscode.window.showInputBox({
				prompt: "Tab label (optional)",
				placeHolder: "e.g. refactor auth",
				title: "New Pi Tab",
				ignoreFocusOut: false,
			});
			// undefined = user cancelled; empty string = skipped label
			if (label === undefined) return; // cancelled

			const colorIndex = bridge.state.tabs.size; // 0-based insertion index
			const cfg3 = vscode.workspace.getConfiguration("piSidebar");
			const palette = cfg3.get<string[]>("tabColorPalette", DEFAULT_PALETTE);
			const tabName = buildTabName(label || undefined, colorIndex);

			const newRes = await createPiTerminal(bridge, context.extensionUri, {
				label: label || undefined,
				colorIndex,
			});
			if (newRes) {
				registerPiTerminal(newRes.terminal, newRes.terminalId);
				// Seed the tab title in bridge state immediately
				upsertTab(bridge.state, newRes.terminalId, { title: tabName });
				controlView?.notifyTabsChanged(
					bridge.state.tabs.toArray(),
					bridge.state.currentTerminalId,
				);
			}
			void palette; // suppress unused warning until tabPalette is used
		}),

		vscode.commands.registerCommand("piSidebar.selectModel", async () => {
			if (!bridge) return;
			const models = controlView?.buildQuickPickModels() ?? commonModels();
			const model = await vscode.window.showQuickPick(models, {
				placeHolder: "Select a model for Pi (switches in-place, no restart)",
			});
			if (!model) return;
			// Always route through controlView.applyModel — same path as the dropdown
			if (controlView) {
				await (controlView as ControlViewProvider).applyModel(model);
			} else {
				// View not open — queue via bridge state directly
				const currentId = bridge.state.currentTerminalId;
				if (currentId && bridge.state.tabs.has(currentId)) {
					bridge.state.pendingModelSwitches.set(currentId, model);
				} else {
					const cfg = vscode.workspace.getConfiguration("piSidebar");
					await cfg.update("defaultModel", model, vscode.ConfigurationTarget.Global);
				}
			}
		}),

		vscode.commands.registerCommand(
			"piSidebar.focusTab",
			async (terminalId: string) => {
				const terminal = terminalMap.get(terminalId);
				if (terminal) {
					terminal.show(true);
				}
			},
		),

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

	// ── Terminal lifecycle listeners ─────────────────────────────────────────
	context.subscriptions.push(
		vscode.window.onDidOpenTerminal((terminal) => {
			if (!isPiTerminal(terminal)) return;
			controlView?.notifyTerminalState(true);
			dropzoneView?.notifyTerminalState(true);
		}),

		vscode.window.onDidCloseTerminal((terminal) => {
			if (!isPiTerminal(terminal)) return;
			sessionTracker?.onClose(terminal);

			// Look up this terminal's id from our reverse map
			const tid = terminalIdMap.get(terminal);

			// 30-second grace period before removing the tab from bridge state.
			// A terminal close during a restart re-creates the terminal immediately;
			// the grace period prevents the strip from flickering.
			if (tid && bridge) {
				const timer = setTimeout(() => {
					closeTimers.delete(tid);
					terminalMap.delete(tid);
					bridge!.state.tabs.remove(tid);
					controlView?.notifyTabsChanged(
						bridge!.state.tabs.toArray(),
						bridge!.state.currentTerminalId,
					);
				}, 30_000);
				closeTimers.set(tid, timer);
			}

			setTimeout(() => {
				const running = !!findPiTerminal();
				controlView?.notifyTerminalState(running);
				dropzoneView?.notifyTerminalState(running);
			}, 250);
		}),

		// Track which Pi terminal the user most recently focused.
		vscode.window.onDidChangeActiveTerminal((terminal) => {
			if (!terminal || !isPiTerminal(terminal)) return;
			const tid = terminalIdMap.get(terminal);
			if (tid && bridge) {
				bridge.state.currentTerminalId = tid;
				try {
					bridge.state.tabs.setCurrent(tid);
				} catch {
					/* tab may not exist yet */
				}
				setLastFocusedTerminalId(tid);
				controlView?.notifyTabsChanged(bridge.state.tabs.toArray(), tid);
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

	// ── Activation reconciliation: sync bridge tabs against running terminals ──
	// Any Pi terminals that survived a window reload are already running —
	// register them so the strip is populated immediately.
	for (const t of findAllPiTerminals()) {
		// We can't recover the original terminalId after a reload, so generate a new one.
		// The pi-side extension will call reportTerminalSession on its next poll,
		// which will upsert the tab with real session data.
		const recoveredId = crypto.randomUUID();
		registerPiTerminal(t, recoveredId);
	}

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
			const startRes = await createPiTerminal(bridge, context.extensionUri);
			if (startRes) registerPiTerminal(startRes.terminal, startRes.terminalId);
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

	// ── OSC 2 tab title setting check (one-time per workspace) ──────────────
	{
		const tabsSettings = vscode.workspace.getConfiguration("terminal.integrated.tabs");
		const currentTitle = tabsSettings.get<string>("title", "");
		if (!currentTitle.includes("${sequence}")) {
			try {
				await tabsSettings.update(
					"title",
					"${sequence}${separator}${localWorkspaceFolder}",
					vscode.ConfigurationTarget.Workspace,
				);
				const notified = context.workspaceState.get<boolean>(
					"piSidebar.oscTitleNotified",
					false,
				);
				if (!notified) {
					await context.workspaceState.update("piSidebar.oscTitleNotified", true);
					vscode.window.showInformationMessage(
						"Pi enabled live tab titles in VS Code’s terminal panel — undo via Settings → Terminal › Integrated › Tabs: Title.",
					);
				}
			} catch {
				// Setting may be locked (e.g. remote workspace) — skip silently
			}
		}
	}

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

/**
 * Apply an incoming agent state to the state machine snapshot for this terminal.
 * Manages idle → clear timers. Called from onTabUpdated.
 */
function applyAgentStateMachine(
	terminalId: string,
	reportedState: string,
): void {
	if (!bridge) return;

	// Map the reported raw state to a machine event
	const eventMap: Record<string, AgentEvent> = {
		working: "agentStart",
		idle: "turnEnd",
		attention: "toolCallNeedsConfirm",
		clear: "terminalSpawned",
	};
	const event = eventMap[reportedState];
	if (!event) return;

	const prev = stateMachineSnapshots.get(terminalId) ?? INITIAL_SNAPSHOT;
	const next = transition(prev, event);
	stateMachineSnapshots.set(terminalId, next);

	// Cancel idle timer when entering working state
	if (next.state === "working") {
		const existing = idleTimers.get(terminalId);
		if (existing) {
			clearTimeout(existing);
			idleTimers.delete(terminalId);
		}
	}

	// Start idle timer when entering idle state
	if (next.state === "idle" && prev.state !== "idle") {
		const cfg = vscode.workspace.getConfiguration("piSidebar");
		const minutes = Math.max(
			1,
			Math.min(120, cfg.get<number>("idleStaleMinutes", 10)),
		);
		const timer = setTimeout(() => {
			idleTimers.delete(terminalId);
			const current = stateMachineSnapshots.get(terminalId);
			if (!current || current.state !== "idle") return; // state changed
			const cleared = transition(current, "idleTimerExpired");
			stateMachineSnapshots.set(terminalId, cleared);
			// Update bridge tab state to "clear"
			if (bridge) {
				upsertTab(bridge.state, terminalId, { agentState: "clear" });
				controlView?.notifyTabsChanged(
					bridge.state.tabs.toArray(),
					bridge.state.currentTerminalId,
				);
			}
		}, minutes * 60 * 1000);
		idleTimers.set(terminalId, timer);
	}
}

/** Returns true if the terminal is a Pi Agent terminal. */
function isPiTerminal(terminal: vscode.Terminal): boolean {
	return (
		terminal.name === TERMINAL_NAME ||
		terminal.name.startsWith(`${TERMINAL_NAME} `)
	);
}

/**
 * Register a newly spawned Pi terminal in the tracking maps.
 * Called by createPiTerminal wrapper in extension so the lifecycle
 * listeners can look up the terminal's id from a WeakMap.
 */
export function registerPiTerminal(
	terminal: vscode.Terminal,
	terminalId: string,
): void {
	terminalMap.set(terminalId, terminal);
	terminalIdMap.set(terminal, terminalId);
	// Cancel any pending grace-period removal for this id (restart scenario)
	const existing = closeTimers.get(terminalId);
	if (existing) {
		clearTimeout(existing);
		closeTimers.delete(terminalId);
	}
	if (bridge) {
		upsertTabInExtension(terminalId, terminal);
	}
}

/** Helper used by registerPiTerminal to upsert the tab in bridge state. */
function upsertTabInExtension(
	terminalId: string,
	_terminal: vscode.Terminal,
): void {
	if (!bridge) return;
	upsertTab(bridge.state, terminalId, { agentState: "clear" });
	// Seed the state machine snapshot so idle-timer logic has a baseline
	stateMachineSnapshots.set(terminalId, INITIAL_SNAPSHOT);
	controlView?.notifyTabsChanged(
		bridge.state.tabs.toArray(),
		bridge.state.currentTerminalId,
	);
}
