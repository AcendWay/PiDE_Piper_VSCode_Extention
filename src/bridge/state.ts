import { AgentTabStateMap } from "../agentTabState";
import type { BridgeEvent, SelectionInfo } from "./types";

const MAX_NOTIFICATIONS = 50;

/** Mutable state shared across all bridge handlers and VS Code event listeners. */
export interface BridgeState {
	/** Per-terminal state map keyed by PI_VSCODE_TERMINAL_ID. */
	tabs: AgentTabStateMap;

	/** The terminalId most recently focused by the user. */
	currentTerminalId: string | null;

	/**
	 * Legacy singleton context usage — kept for backwards compat with pi-side
	 * extensions that have not yet been updated to include terminalId.
	 * New code reads from tabs.getCurrent()?.contextUsage instead.
	 */
	contextUsage: { used: number; total: number } | null;

	/** Last selection seen — survives focus moving to the terminal. */
	latestSelection: SelectionInfo | null;

	/** Ring buffer of VS Code events for pi to poll. */
	notifications: BridgeEvent[];

	/** terminalId → sessionFile — populated by reportTerminalSession. */
	terminalSessions: Map<string, string>;

	/** Callback invoked when pi reports its session file. */
	reportTerminalSession: (terminalId: string, sessionFile: string) => void;
}

export function createBridgeState(
	onTerminalSession: (terminalId: string, sessionFile: string) => void,
): BridgeState {
	return {
		tabs: new AgentTabStateMap(),
		currentTerminalId: null,
		contextUsage: null,
		latestSelection: null,
		notifications: [],
		terminalSessions: new Map(),
		reportTerminalSession: onTerminalSession,
	};
}

export function pushNotification(state: BridgeState, event: BridgeEvent): void {
	state.notifications.push(event);
	if (state.notifications.length > MAX_NOTIFICATIONS) {
		state.notifications.shift();
	}
}

// ── Tab helpers ───────────────────────────────────────────────────────────────

/** Upsert a tab entry, deriving a display title from the index if none given. */
export function upsertTab(
	state: BridgeState,
	terminalId: string,
	partial: Parameters<AgentTabStateMap["upsert"]>[1],
): void {
	const existing = state.tabs.get(terminalId);
	const title =
		partial.title ??
		existing?.title ??
		(state.tabs.size === 0 ? "Pi Agent" : `Pi Agent ${state.tabs.size + 1}`);
	state.tabs.upsert(terminalId, { ...partial, title });
}

/** Remove a tab and optionally sync contextUsage singleton. */
export function removeTab(state: BridgeState, terminalId: string): void {
	state.tabs.remove(terminalId);
	// Keep legacy singleton in sync with the new current tab (if any)
	const cur = state.tabs.getCurrent();
	state.contextUsage = cur?.contextUsage ?? null;
}
