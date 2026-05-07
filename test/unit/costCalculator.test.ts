import { describe, it, expect } from "vitest";
import {
	cost,
	delta,
	fmtTokens,
	fmtCost,
	type UsageRecord,
	type RateTable,
} from "../../src/costCalculator";

const FREE_RATES: RateTable = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

// Claude Sonnet 4-ish rates for hand-computable tests
const PAID_RATES: RateTable = {
	input: 3.0,        // $3 per million input tokens
	output: 15.0,      // $15 per million output
	cacheRead: 0.3,    // $0.30 per million cache reads
	cacheWrite: 3.75,  // $3.75 per million cache writes
};

describe("costCalculator.cost", () => {
	it("zero-cost model returns 0", () => {
		const usage: UsageRecord = {
			input: 100_000,
			output: 50_000,
			cacheRead: 200_000,
			cacheWrite: 10_000,
		};
		expect(cost(usage, FREE_RATES)).toBe(0);
	});

	it("paid model with all four rate fields — hand-computable", () => {
		const usage: UsageRecord = {
			input: 1_000_000,    // $3.00
			output: 200_000,     // $3.00
			cacheRead: 500_000,  // $0.15
			cacheWrite: 100_000, // $0.375
		};
		// Expected: 3.00 + 3.00 + 0.15 + 0.375 = $6.525
		expect(cost(usage, PAID_RATES)).toBeCloseTo(6.525, 6);
	});

	it("usage with zero cache", () => {
		const usage: UsageRecord = {
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
		};
		// 3.00 + 15.00 = $18.00
		expect(cost(usage, PAID_RATES)).toBeCloseTo(18.0, 6);
	});

	it("usage with mostly cache (cheap reads)", () => {
		const usage: UsageRecord = {
			input: 100,
			output: 100,
			cacheRead: 1_000_000,  // $0.30 — the bulk
			cacheWrite: 0,
		};
		// 0.0003 + 0.0015 + 0.30 + 0 ≈ $0.3018
		expect(cost(usage, PAID_RATES)).toBeCloseTo(0.3018, 4);
	});

	it("clamps negative usage values to 0", () => {
		const bad: UsageRecord = {
			input: -1000,
			output: -500,
			cacheRead: 0,
			cacheWrite: 0,
		};
		expect(cost(bad, PAID_RATES)).toBe(0);
	});

	it("handles missing rate fields", () => {
		const partial = { input: 5, output: 10 } as RateTable;
		const usage: UsageRecord = {
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 1_000_000,
			cacheWrite: 1_000_000,
		};
		// cacheRead/cacheWrite rate undefined → 0 → only input + output count
		expect(cost(usage, partial)).toBeCloseTo(15.0, 6);
	});
});

describe("costCalculator.delta", () => {
	const u1: UsageRecord = {
		input: 1000,
		output: 500,
		cacheRead: 200,
		cacheWrite: 50,
	};
	const u2: UsageRecord = {
		input: 2000,
		output: 1000,
		cacheRead: 400,
		cacheWrite: 100,
	};

	it("returns 0 when prev === current (same reference)", () => {
		expect(delta(u1, u1, PAID_RATES)).toBe(0);
	});

	it("returns 0 when usages are identical objects", () => {
		const u1Copy = { ...u1 };
		expect(delta(u1, u1Copy, PAID_RATES)).toBe(0);
	});

	it("returns positive delta for forward usage growth", () => {
		const result = delta(u1, u2, PAID_RATES);
		// cost(u2) - cost(u1) > 0
		expect(result).toBeGreaterThan(0);
		// Specifically: it should equal cost(u2) - cost(u1)
		expect(result).toBeCloseTo(cost(u2, PAID_RATES) - cost(u1, PAID_RATES), 6);
	});

	it("clamps to 0 when current < prev (prevents negative)", () => {
		// Reverse direction — usually impossible, but defend against it
		const result = delta(u2, u1, PAID_RATES);
		expect(result).toBe(0);
	});

	it("delta on free rates is always 0", () => {
		expect(delta(u1, u2, FREE_RATES)).toBe(0);
	});
});

describe("costCalculator.fmtTokens", () => {
	it("returns '0' for falsy/zero input", () => {
		expect(fmtTokens(0)).toBe("0");
	});

	it("< 1k formatted as raw integer", () => {
		expect(fmtTokens(999)).toBe("999");
		expect(fmtTokens(123)).toBe("123");
	});

	it("< 1M formatted as Nk with one decimal", () => {
		expect(fmtTokens(1500)).toBe("1.5k");
		expect(fmtTokens(58000)).toBe("58.0k");
	});

	it(">= 1M formatted as NM with one decimal", () => {
		expect(fmtTokens(1_200_000)).toBe("1.2M");
		expect(fmtTokens(2_500_000)).toBe("2.5M");
	});
});

describe("costCalculator.fmtCost", () => {
	it("returns '$0.00' for zero", () => {
		expect(fmtCost(0)).toBe("$0.00");
	});

	it("< $0.01 formatted with 4 decimals", () => {
		expect(fmtCost(0.0034)).toBe("$0.0034");
	});

	it("< $1 formatted with 3 decimals", () => {
		expect(fmtCost(0.18)).toBe("$0.180");
	});

	it(">= $1 formatted with 2 decimals", () => {
		expect(fmtCost(4.27)).toBe("$4.27");
		expect(fmtCost(123.456)).toBe("$123.46");
	});
});
