import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// Load the CJS bridge-extension module via createRequire
const _require = createRequire(import.meta.url);
const { contextBreakdown } = _require(
	"../../src/bridge-extension/contextBreakdown.js",
);

// ── Fixture helpers ───────────────────────────────────────────────────────────

function userEntry(id: string, parentId: string, text: string) {
	return {
		type: "message",
		id,
		parentId,
		message: { role: "user", content: text },
	};
}

function assistantEntry(
	id: string,
	parentId: string,
	text: string,
	usage?: object,
) {
	return {
		type: "message",
		id,
		parentId,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: usage ?? null,
		},
	};
}

function toolResultEntry(id: string, parentId: string, text: string) {
	return {
		type: "message",
		id,
		parentId,
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
		},
	};
}

const USAGE = {
	input: 5000,
	output: 1000,
	cacheRead: 2000,
	cacheWrite: 500,
	totalTokens: 8500,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

// ── Fixture 1: Fresh session (no messages) ────────────────────────────────────
const FRESH_ENTRIES = [
	{ type: "session", id: "sess", version: 3, cwd: "/tmp" },
];

// ── Fixture 2: Mid-conversation with tool calls ───────────────────────────────
const MIDCONV_ENTRIES = [
	{ type: "session", id: "sess", version: 3, cwd: "/tmp" },
	userEntry("u1", "sess", "Please analyze this file."),
	assistantEntry("a1", "u1", "I'll analyze it.", USAGE),
	toolResultEntry("tr1", "a1", "file contents here..."),
];

// ── Fixture 3: Session with systemPromptOptions ───────────────────────────────
const SPO = {
	contextFiles: ["AGENTS.md content..."],
	skills: ["skill instructions..."],
	customPrompts: ["custom prompt text"],
	guidelines: ["be concise"],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("contextBreakdown — fresh session", () => {
	it("returns all zeros for an empty session", () => {
		const result = contextBreakdown({
			entries: FRESH_ENTRIES,
			systemPrompt: "",
			lastUsage: null,
			contextWindow: 200000,
		});
		expect(result.schemeA.conversationTokens).toBe(0);
		expect(result.schemeA.toolIoTokens).toBe(0);
		expect(result.schemeA.cacheTokens).toBe(0);
		expect(result.totalTokens).toBe(0);
	});

	it("includes contextWindow in result", () => {
		const result = contextBreakdown({ entries: [], contextWindow: 128000 });
		expect(result.contextWindow).toBe(128000);
	});
});

describe("contextBreakdown — mid-conversation with tool calls", () => {
	it("uses lastUsage.totalTokens as ground-truth totalTokens", () => {
		const result = contextBreakdown({
			entries: MIDCONV_ENTRIES,
			lastUsage: USAGE,
			contextWindow: 200000,
		});
		expect(result.totalTokens).toBe(USAGE.totalTokens);
	});

	it("cache overlay equals cacheRead + cacheWrite from lastUsage", () => {
		const result = contextBreakdown({
			entries: MIDCONV_ENTRIES,
			lastUsage: USAGE,
			contextWindow: 200000,
		});
		expect(result.schemeA.cacheTokens).toBe(USAGE.cacheRead + USAGE.cacheWrite);
	});

	it("schemeB sub-buckets sum to their parent schemeA buckets", () => {
		const result = contextBreakdown({
			entries: MIDCONV_ENTRIES,
			systemPrompt: "You are a helpful assistant.",
			systemPromptOptions: SPO,
			lastUsage: USAGE,
			contextWindow: 200000,
		});
		// conversationTokens = user + assistant
		expect(result.schemeA.conversationTokens).toBe(
			result.schemeB.user + result.schemeB.assistant,
		);
		// toolIoTokens = toolIo
		expect(result.schemeA.toolIoTokens).toBe(result.schemeB.toolIo);
		// systemTokens = systemCore + contextFiles + skills
		expect(result.schemeA.systemTokens).toBe(
			result.schemeB.systemCore +
				result.schemeB.contextFiles +
				result.schemeB.skills,
		);
	});

	it("user and assistant tokens are non-zero when messages exist", () => {
		const result = contextBreakdown({
			entries: MIDCONV_ENTRIES,
			contextWindow: 200000,
		});
		expect(result.schemeB.user).toBeGreaterThan(0);
		expect(result.schemeB.assistant).toBeGreaterThan(0);
	});

	it("toolIo tokens are non-zero when toolResult messages exist", () => {
		const result = contextBreakdown({
			entries: MIDCONV_ENTRIES,
			contextWindow: 200000,
		});
		expect(result.schemeB.toolIo).toBeGreaterThan(0);
	});
});

describe("contextBreakdown — with systemPromptOptions", () => {
	it("contextFiles tokens counted in systemTokens", () => {
		const result = contextBreakdown({
			entries: FRESH_ENTRIES,
			systemPrompt: "",
			systemPromptOptions: SPO,
			contextWindow: 200000,
		});
		expect(result.schemeB.contextFiles).toBeGreaterThan(0);
		expect(result.schemeA.systemTokens).toBeGreaterThan(0);
	});

	it("skills from customPrompts and guidelines are counted", () => {
		const result = contextBreakdown({
			entries: FRESH_ENTRIES,
			systemPromptOptions: SPO,
			contextWindow: 200000,
		});
		expect(result.schemeB.skills).toBeGreaterThan(0);
	});

	it("systemCore comes from the systemPrompt string", () => {
		const resultWithPrompt = contextBreakdown({
			entries: FRESH_ENTRIES,
			systemPrompt: "You are a helpful coding assistant with many instructions.",
			contextWindow: 200000,
		});
		const resultNoPrompt = contextBreakdown({
			entries: FRESH_ENTRIES,
			systemPrompt: "",
			contextWindow: 200000,
		});
		expect(resultWithPrompt.schemeB.systemCore).toBeGreaterThan(
			resultNoPrompt.schemeB.systemCore,
		);
	});
});

describe("contextBreakdown — missing systemPromptOptions", () => {
	it("does not crash when systemPromptOptions is null", () => {
		expect(() =>
			contextBreakdown({
				entries: MIDCONV_ENTRIES,
				systemPromptOptions: null,
				contextWindow: 200000,
			}),
		).not.toThrow();
	});

	it("contextFiles and skills are 0 when systemPromptOptions is absent", () => {
		const result = contextBreakdown({
			entries: MIDCONV_ENTRIES,
			systemPromptOptions: null,
			contextWindow: 200000,
		});
		expect(result.schemeB.contextFiles).toBe(0);
		expect(result.schemeB.skills).toBe(0);
	});
});

describe("contextBreakdown — cost tracking", () => {
	it("sessionCost accumulates from all assistant messages", () => {
		const multiTurn = [
			{ type: "session", id: "s", version: 3, cwd: "/tmp" },
			userEntry("u1", "s", "hello"),
			assistantEntry("a1", "u1", "hi", { ...USAGE, cost: { total: 0.01 } }),
			userEntry("u2", "a1", "world"),
			assistantEntry("a2", "u2", "bye", { ...USAGE, cost: { total: 0.02 } }),
		];
		const result = contextBreakdown({ entries: multiTurn, contextWindow: 200000 });
		expect(result.sessionCost).toBeCloseTo(0.03, 5);
	});

	it("lastDelta comes from the lastUsage.cost.total", () => {
		const result = contextBreakdown({
			entries: MIDCONV_ENTRIES,
			lastUsage: { ...USAGE },
			contextWindow: 200000,
		});
		expect(result.lastDelta).toBe(USAGE.cost.total);
	});
});
