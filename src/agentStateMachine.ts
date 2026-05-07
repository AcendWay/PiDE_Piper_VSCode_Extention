/**
 * agentStateMachine.ts
 *
 * Pure state machine for Pi Agent session lifecycle.
 * No VS Code or pi dependencies — fully unit-testable.
 *
 * State → what it means in the sidebar dot:
 *   working   🟢  LLM thinking or tool executing
 *   idle      🟡  Turn finished, waiting for next user message
 *   attention 🔴  Blocked on user permission / query
 *   clear     ⚪  Not yet started or stale past idle threshold
 */

export type AgentState = "working" | "idle" | "attention" | "clear";

export type AgentEvent =
	| "terminalSpawned"
	| "agentStart"
	| "turnStart"
	| "turnEnd"
	| "toolExecutionStart"
	| "toolExecutionEnd"
	| "toolCallNeedsConfirm"
	| "toolCallConfirmed"
	| "agentEnd"
	| "idleTimerExpired";

export interface StateMachineSnapshot {
	/** Current agent lifecycle state. */
	state: AgentState;
	/**
	 * Number of tool_calls that have been preflighted but not yet confirmed
	 * or started execution. Used to prevent `turnEnd` from flipping to `idle`
	 * when a confirm dialog is open.
	 */
	pendingConfirms: number;
}

export const INITIAL_SNAPSHOT: StateMachineSnapshot = {
	state: "clear",
	pendingConfirms: 0,
};

/**
 * Pure transition function.
 * Given the current snapshot and an event, returns the next snapshot.
 * Always returns a new object — never mutates the input.
 */
export function transition(
	current: StateMachineSnapshot,
	event: AgentEvent,
): StateMachineSnapshot {
	const { state, pendingConfirms } = current;

	switch (event) {
		// ── Spawned / reset ──────────────────────────────────────────────────
		case "terminalSpawned":
			return { state: "clear", pendingConfirms: 0 };

		// ── Working transitions ──────────────────────────────────────────────
		// Any of these cancel pending idle timers at the call-site.
		case "agentStart":
		case "turnStart":
		case "toolExecutionStart":
		case "toolExecutionEnd":
			// toolExecutionEnd: still in a turn, LLM will respond shortly → keep working
			return { state: "working", pendingConfirms };

		// ── Attention ────────────────────────────────────────────────────────
		case "toolCallNeedsConfirm":
			// Overrides ANY state — user must act.
			return { state: "attention", pendingConfirms: pendingConfirms + 1 };

		case "toolCallConfirmed": {
			const remaining = Math.max(0, pendingConfirms - 1);
			// Only leave attention when all pending confirms are resolved.
			const newState =
				state === "attention" && remaining === 0 ? "working" : state;
			return { state: newState, pendingConfirms: remaining };
		}

		// ── Idle transitions ─────────────────────────────────────────────────
		case "turnEnd":
		case "agentEnd":
			// Don't override attention — user still has a pending confirm.
			if (pendingConfirms > 0) return current;
			return { state: "idle", pendingConfirms: 0 };

		// ── Stale transition (fired by extension idle timer) ─────────────────
		case "idleTimerExpired":
			if (state === "idle") return { state: "clear", pendingConfirms: 0 };
			return current; // Not idle — ignore (timer was stale)

		default:
			return current;
	}
}
