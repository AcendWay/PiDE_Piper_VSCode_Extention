/**
 * agentTabState.ts
 *
 * Pure data container for per-terminal Pi Agent state.
 * No VS Code dependencies — fully unit-testable.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentState = "working" | "idle" | "attention" | "clear";

export interface AgentTabState {
	terminalId: string;
	/** Display title — either user-supplied label or auto-derived from first message. */
	title: string;
	/** Session JSON file path once pi reports it. */
	sessionFile?: string;
	/** Active model name once reported. */
	model?: string;
	/** Context window usage — populated by reportContextUsage. */
	contextUsage?: { used: number; total: number };
	/** Agent lifecycle state — populated by reportAgentState (Phase 5). */
	agentState: AgentState;
	/** ISO timestamp of the last state transition. */
	since: string;
	/** Tab index (0-based insertion order, used for palette color). */
	index: number;
	// ── Breakdown (Slice 7 / #22) ──────────────────────────────────────────
	breakdown?: ContextBreakdown | null;
	cost?: SessionCost | null;
}

// ── Breakdown types ──────────────────────────────────────────────────────────

export interface ContextBreakdown {
	schemeA: {
		systemTokens: number;
		conversationTokens: number;
		toolIoTokens: number;
		cacheTokens: number;
	};
	schemeB: {
		systemCore: number;
		contextFiles: number;
		skills: number;
		user: number;
		assistant: number;
		toolIo: number;
	};
	totalTokens: number;
	contextWindow: number;
}

export interface SessionCost {
	sessionCost: number;
	lastDelta: number;
}

// ── Container ─────────────────────────────────────────────────────────────────

export class AgentTabStateMap {
	private readonly _tabs = new Map<string, AgentTabState>();
	private _currentId: string | null = null;
	/** Insertion-order list of terminalIds (mirrors Map iteration order). */
	private _insertionOrder: string[] = [];

	// ── Mutations ────────────────────────────────────────────────────────────

	/**
	 * Insert or update a tab entry.
	 * Idempotent: calling upsert with the same terminalId only updates
	 * the supplied fields; it does not change the tab's index or insertion order.
	 */
	upsert(
		terminalId: string,
		partial: Partial<Omit<AgentTabState, "terminalId" | "index">>,
	): AgentTabState {
		const existing = this._tabs.get(terminalId);
		if (existing) {
			const updated: AgentTabState = { ...existing, ...partial, terminalId };
			this._tabs.set(terminalId, updated);
			return updated;
		}
		// New entry — assign the next index.
		const entry: AgentTabState = {
			terminalId,
			title: partial.title ?? "Pi Agent",
			sessionFile: partial.sessionFile,
			model: partial.model,
			contextUsage: partial.contextUsage,
			agentState: partial.agentState ?? "clear",
			since: partial.since ?? new Date().toISOString(),
			index: this._insertionOrder.length,
			breakdown: partial.breakdown ?? null,
			cost: partial.cost ?? null,
		};
		this._tabs.set(terminalId, entry);
		this._insertionOrder.push(terminalId);
		return entry;
	}

	/** Remove a tab. If it was current, current becomes null. */
	remove(terminalId: string): boolean {
		const existed = this._tabs.delete(terminalId);
		if (existed) {
			this._insertionOrder = this._insertionOrder.filter(
				(id) => id !== terminalId,
			);
			if (this._currentId === terminalId) this._currentId = null;
		}
		return existed;
	}

	/** Set the currently-active tab. Throws if the id is not in the map. */
	setCurrent(terminalId: string): void {
		if (!this._tabs.has(terminalId)) {
			throw new Error(
				`AgentTabStateMap.setCurrent: unknown terminalId "${terminalId}"`,
			);
		}
		this._currentId = terminalId;
	}

	// ── Queries ──────────────────────────────────────────────────────────────

	get(terminalId: string): AgentTabState | undefined {
		return this._tabs.get(terminalId);
	}

	getCurrent(): AgentTabState | undefined {
		if (!this._currentId) return undefined;
		return this._tabs.get(this._currentId);
	}

	get currentId(): string | null {
		return this._currentId;
	}

	get size(): number {
		return this._tabs.size;
	}

	/** Iterate in insertion order. */
	forEach(cb: (state: AgentTabState, terminalId: string) => void): void {
		for (const id of this._insertionOrder) {
			const tab = this._tabs.get(id);
			if (tab) cb(tab, id);
		}
	}

	/** Return all tabs as an array in insertion order. */
	toArray(): AgentTabState[] {
		return this._insertionOrder
			.map((id) => this._tabs.get(id))
			.filter((t): t is AgentTabState => t !== undefined);
	}

	has(terminalId: string): boolean {
		return this._tabs.has(terminalId);
	}
}
