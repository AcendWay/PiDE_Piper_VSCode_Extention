import type { BridgeEvent, SelectionInfo } from "./types";

const MAX_NOTIFICATIONS = 50;

/** Mutable state shared across all bridge handlers and VS Code event listeners. */
export interface BridgeState {
	/** Latest reported context window usage from the pi session. */
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
		contextUsage: null,
		latestSelection: null,
		notifications: [],
		terminalSessions: new Map(),
		reportTerminalSession: onTerminalSession,
	};
}

export function pushNotification(
	state: BridgeState,
	event: BridgeEvent,
): void {
	state.notifications.push(event);
	if (state.notifications.length > MAX_NOTIFICATIONS) {
		state.notifications.shift();
	}
}
