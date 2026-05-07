/**
 * piEventBridge.js
 *
 * Pi-side event orchestrator.
 * Subscribes to pi's lifecycle events and forwards agent state changes
 * to the VS Code bridge via the HTTP callVsCode function.
 *
 * Architecture note: the state machine lives on the extension side
 * (agentStateMachine.ts). This module sends raw state labels derived
 * from pi events, keeping the pi side simple and the state machine
 * cleanly testable in isolation.
 */

// ── Agent state reporting ─────────────────────────────────────────────────────

/**
 * @param {Function} callVsCode - bridge HTTP helper
 * @param {object} pi - pi extension host
 * @param {string} terminalId - PI_VSCODE_TERMINAL_ID for this session
 */
function startEventBridge(callVsCode, pi, terminalId) {
	if (!terminalId) return;
	if (!process.env.PI_VSCODE_BRIDGE_URL || !process.env.PI_VSCODE_BRIDGE_TOKEN)
		return;

	let _confirmTimer = null;
	let _pendingToolCalls = 0;

	function report(state) {
		callVsCode("reportAgentState", {
			terminalId,
			state,
			since: new Date().toISOString(),
		}).catch(() => {});
	}

	// ── WORKING: LLM is about to be called ────────────────────────────────
	pi.on("before_provider_request", () => {
		report("working");
	});

	// ── WORKING: agent turn is starting ───────────────────────────────────
	pi.on("agent_start", () => {
		report("working");
	});

	// ── WORKING: a tool is starting execution ─────────────────────────────
	// Also clears any pending confirm timer (tool was approved / no confirm needed)
	pi.on("tool_execution_start", () => {
		if (_confirmTimer) {
			clearTimeout(_confirmTimer);
			_confirmTimer = null;
		}
		_pendingToolCalls = Math.max(0, _pendingToolCalls - 1);
		report("working");
	});

	// ── ATTENTION: tool was preflighted but hasn't started in time ─────────
	// If tool_execution_start doesn't fire within 5s of tool_call, the tool
	// is likely blocked on a user confirmation prompt.
	pi.on("tool_call", () => {
		_pendingToolCalls++;
		// Cancel existing timer so we use the latest tool_call's window
		if (_confirmTimer) clearTimeout(_confirmTimer);
		_confirmTimer = setTimeout(() => {
			_confirmTimer = null;
			if (_pendingToolCalls > 0) {
				report("attention");
			}
		}, 5_000);
	});


	// ── Title tracking ────────────────────────────────────────────────────
	let _firstUserMessage = null; // captured from first turn_start
	let _titleSet = false;        // whether OSC 2 has been emitted yet
	let _systemPromptOptions = null; // captured from before_agent_start
	let _systemPrompt = '';          // captured from before_agent_start
	let _contextWindow = 0;          // active model context window

	pi.on("before_agent_start", async (event) => {
		if (event) {
			_systemPromptOptions = event.systemPromptOptions || null;
			_systemPrompt = event.systemPrompt || '';
			if (event.model && event.model.contextWindow) {
				_contextWindow = event.model.contextWindow;
			}
		}
	});

	pi.on("turn_start", (event) => {
		if (!_firstUserMessage && event && event.prompt) {
			_firstUserMessage = String(event.prompt).slice(0, 30).replace(/\n/g, " ");
		}
	});

	// ── IDLE: turn completed ───────────────────────────────────────────────
	pi.on("turn_end", () => {
		_pendingToolCalls = 0;
		if (_confirmTimer) {
			clearTimeout(_confirmTimer);
			_confirmTimer = null;
		}
		report("idle");

		// After the first turn, emit an OSC 2 title derived from the first user message.
		// Only fires once per session (user-supplied label takes precedence if set).
		if (!_titleSet && _firstUserMessage) {
			_titleSet = true;
			const label = "Pi Agent \u00b7 " + _firstUserMessage;
			// Write OSC 2 escape sequence — VS Code updates the terminal tab title
			process.stdout.write("\x1b]2;" + label + "\x07");
			// Mirror to bridge so the mini-tab-strip stays in sync
			callVsCode("reportTerminalTitle", { terminalId, title: label }).catch(() => {});
		}
	});

	// ── Context breakdown after each assistant message ────────────────────
	pi.on("message_end", async (event, ctx) => {
		// Only recompute after assistant messages (which carry usage data)
		if (!event?.message || event.message.role !== "assistant") return;
		try {
			const entries = ctx.sessionManager?.getBranch?.() || [];
			const lastUsage = event.message.usage || null;
			const cw = _contextWindow || ctx.getContextUsage?.()?.contextWindow || 0;

			const result = contextBreakdown({
				entries,
				systemPromptOptions: _systemPromptOptions,
				systemPrompt: _systemPrompt,
				lastUsage,
				contextWindow: cw,
			});

			// Report context breakdown
			await callVsCode("reportContextBreakdown", {
				terminalId,
				breakdown: result,
			}).catch(() => {});

			// Report cost
			await callVsCode("reportCost", {
				terminalId,
				sessionCost: result.sessionCost,
				lastDelta: result.lastDelta,
			}).catch(() => {});
		} catch {
			// Breakdown failed — skip silently
		}
	});

	// ── IDLE: agent session ended ──────────────────────────────────────────
	pi.on("agent_end", () => {
		_pendingToolCalls = 0;
		if (_confirmTimer) {
			clearTimeout(_confirmTimer);
			_confirmTimer = null;
		}
		report("idle");
	});

	// ── WORKING: user provided input while in attention ────────────────────
	// When the user types (approves a confirm dialog or sends a message),
	// transition back to working.
	pi.on("input", () => {
		_pendingToolCalls = 0;
		if (_confirmTimer) {
			clearTimeout(_confirmTimer);
			_confirmTimer = null;
		}
		// Only transition if currently in attention (user approved something)
		// or clear (new message starting a session). For idle it's handled by
		// agent_start / before_provider_request.
		report("working");
	});

	// Clean up on process exit
	process.once("exit", () => {
		if (_confirmTimer) clearTimeout(_confirmTimer);
	});
}

const { contextBreakdown } = require('./contextBreakdown');

module.exports = { startEventBridge };
