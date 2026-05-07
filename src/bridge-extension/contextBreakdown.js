/**
 * contextBreakdown.js
 *
 * Pure function computing pi session context breakdown.
 * Used by piEventBridge to report Scheme A + Scheme B token buckets
 * to the VS Code sidebar.
 *
 * No pi API calls — takes pre-extracted data as input.
 * Fully testable with fixture data.
 */

// ── Token estimation helpers ─────────────────────────────────────────────────

/** Estimate tokens for a plain string (~4 chars per token). */
function estimateStr(str) {
	if (!str) return 0;
	return Math.ceil(String(str).length / 4);
}

/** Estimate tokens for a content block array or string. */
function estimateContent(content) {
	if (!content) return 0;
	if (typeof content === "string") return estimateStr(content);
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!block) continue;
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "thinking" && block.thinking) {
			chars += block.thinking.length;
		} else if (block.type === "toolCall") {
			chars +=
				(block.name || "").length +
				JSON.stringify(block.arguments || {}).length;
		} else if (block.type === "image") {
			// base64 image — rough estimate
			chars += (block.data || "").length / 4;
		}
	}
	return Math.ceil(chars / 4);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute Scheme A (4 buckets) and Scheme B (6 sub-buckets) from pi session data.
 *
 * @param {object} params
 * @param {object[]} params.entries   - Session entries from ctx.sessionManager.getBranch()
 * @param {object}  params.systemPromptOptions - From before_agent_start event (may be null)
 * @param {string}  params.systemPrompt        - System prompt string (may be empty)
 * @param {object}  params.lastUsage           - Last assistant message usage (may be null)
 * @param {number}  params.contextWindow       - Active model context window size
 * @returns Breakdown object with schemeA, schemeB, totalTokens, contextWindow
 */
function contextBreakdown({
	entries = [],
	systemPromptOptions = null,
	systemPrompt = "",
	lastUsage = null,
	contextWindow = 0,
}) {
	// ── Extract usage totals from the last assistant message ──────────────
	let usageTotalTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let sessionCost = 0;
	let lastMsgCost = 0;

	if (lastUsage) {
		usageTotalTokens =
			lastUsage.totalTokens ||
			(lastUsage.input || 0) +
				(lastUsage.output || 0) +
				(lastUsage.cacheRead || 0) +
				(lastUsage.cacheWrite || 0);
		cacheRead = lastUsage.cacheRead || 0;
		cacheWrite = lastUsage.cacheWrite || 0;
		lastMsgCost = lastUsage.cost?.total || 0;
	}
	const cacheTokens = cacheRead + cacheWrite;

	// ── Walk entries and bucket message tokens ────────────────────────────
	let userTokens = 0;
	let assistantTokens = 0;
	let toolIoTokens = 0;

	for (const entry of entries) {
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || !msg.role) continue;

		switch (msg.role) {
			case "user":
				userTokens += estimateContent(msg.content);
				break;
			case "assistant":
				assistantTokens += estimateContent(msg.content);
				// Accumulate session cost from all assistant messages
				if (msg.usage?.cost?.total) sessionCost += msg.usage.cost.total;
				break;
			case "toolResult":
				toolIoTokens += estimateContent(msg.content);
				break;
			default:
				break;
		}
	}

	// ── System prompt sub-buckets ─────────────────────────────────────────
	const systemCoreTokens = estimateStr(systemPrompt);
	let contextFileTokens = 0;
	let skillTokens = 0;

	if (systemPromptOptions) {
		for (const cf of systemPromptOptions.contextFiles || []) {
			contextFileTokens += estimateStr(
				typeof cf === "string" ? cf : JSON.stringify(cf),
			);
		}
		for (const sk of systemPromptOptions.skills || []) {
			skillTokens += estimateStr(
				typeof sk === "string" ? sk : JSON.stringify(sk),
			);
		}
		for (const cp of systemPromptOptions.customPrompts || []) {
			skillTokens += estimateStr(
				typeof cp === "string" ? cp : JSON.stringify(cp),
			);
		}
		for (const g of systemPromptOptions.guidelines || []) {
			skillTokens += estimateStr(
				typeof g === "string" ? g : JSON.stringify(g),
			);
		}
	}

	const systemTokens = systemCoreTokens + contextFileTokens + skillTokens;
	const conversationTokens = userTokens + assistantTokens;

	// Use actual LLM-reported total when available; fall back to estimate
	const totalTokens =
		usageTotalTokens > 0
			? usageTotalTokens
			: systemTokens + conversationTokens + toolIoTokens;

	return {
		schemeA: { systemTokens, conversationTokens, toolIoTokens, cacheTokens },
		schemeB: {
			systemCore: systemCoreTokens,
			contextFiles: contextFileTokens,
			skills: skillTokens,
			user: userTokens,
			assistant: assistantTokens,
			toolIo: toolIoTokens,
		},
		totalTokens,
		contextWindow,
		sessionCost,
		lastDelta: lastMsgCost,
	};
}

module.exports = { contextBreakdown, estimateStr, estimateContent };
