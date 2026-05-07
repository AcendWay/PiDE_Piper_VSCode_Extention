/**
 * costCalculator.ts
 *
 * Pure cost arithmetic for Pi Agent sessions.
 * No VS Code or pi dependencies — fully unit-testable.
 *
 * Token usage records and rate tables follow pi's native shape:
 * usage = { input, output, cacheRead, cacheWrite, totalTokens? }
 * rates = { input, output, cacheRead, cacheWrite } in $ per million tokens
 */

export interface UsageRecord {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
}

export interface RateTable {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const ONE_MILLION = 1_000_000;

/**
 * Compute total cost in $ from a usage record + rate table.
 * Rates are $ per million tokens.
 * Negative inputs are clamped to 0.
 */
export function cost(usage: UsageRecord, rates: RateTable): number {
	const i = Math.max(0, usage.input || 0);
	const o = Math.max(0, usage.output || 0);
	const cr = Math.max(0, usage.cacheRead || 0);
	const cw = Math.max(0, usage.cacheWrite || 0);

	const ri = rates.input || 0;
	const ro = rates.output || 0;
	const rcr = rates.cacheRead || 0;
	const rcw = rates.cacheWrite || 0;

	return (
		(i * ri + o * ro + cr * rcr + cw * rcw) / ONE_MILLION
	);
}

/**
 * Incremental cost between two usage snapshots.
 * Never negative (clamps to 0). Returns 0 when prev === current.
 */
export function delta(
	prev: UsageRecord,
	current: UsageRecord,
	rates: RateTable,
): number {
	if (prev === current) return 0;
	const prevCost = cost(prev, rates);
	const curCost = cost(current, rates);
	return Math.max(0, curCost - prevCost);
}

// ── Token formatting helper ───────────────────────────────────────────────────

/**
 * Format a token count: < 1k = raw, < 1M = Nk (1 decimal), ≥ 1M = NM (1 decimal).
 */
export function fmtTokens(n: number): string {
	if (!n) return "0";
	if (n >= ONE_MILLION) return `${(n / ONE_MILLION).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

/** Format a cost in $: < $0.01 → 4dp, < $1 → 3dp, ≥ $1 → 2dp. */
export function fmtCost(c: number): string {
	if (!c) return "$0.00";
	if (c < 0.01) return `$${c.toFixed(4)}`;
	if (c < 1) return `$${c.toFixed(3)}`;
	return `$${c.toFixed(2)}`;
}
