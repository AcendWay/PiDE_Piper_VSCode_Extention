/**
 * piVscodeTools.js
 *
 * Pi-side extension loaded via --extension flag.
 * Registers VS Code bridge tools that call back to the HTTP bridge server
 * running in the VS Code extension host.
 *
 * Environment variables (set by the extension):
 *   PI_VSCODE_BRIDGE_URL   e.g. http://127.0.0.1:54321
 *   PI_VSCODE_BRIDGE_TOKEN 48-char hex security token
 */



const http = require("node:http");
const https = require("node:https");
const { Type } = require("typebox");

// ── HTTP bridge call ────────────────────────────────────────────────────────

function callVsCode(action, payload) {
	const rawUrl = process.env.PI_VSCODE_BRIDGE_URL || "";
	const token = process.env.PI_VSCODE_BRIDGE_TOKEN || "";

	if (!rawUrl || !token) {
		throw new Error(
			"VS Code bridge unavailable. Start Pi from the Pi Sidebar extension.",
		);
	}

	const url = new URL("/bridge", rawUrl);
	const body = JSON.stringify({ token, action, payload });
	const lib = url.protocol === "https:" ? https : http;

	return new Promise((resolve, reject) => {
		const req = lib.request(
			{
				hostname: url.hostname,
				port: url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80),
				path: url.pathname,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
				timeout: 30_000,
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => { data += chunk; });
				res.on("end", () => {
					try {
						const msg = JSON.parse(data);
						if (msg.ok) {
							resolve(
								typeof msg.result === "string"
									? msg.result
									: JSON.stringify(msg.result, null, 2),
							);
						} else {
							reject(new Error(msg.error || "VS Code bridge call failed"));
						}
					} catch (e) {
						reject(new Error(`Bridge response parse error: ${e.message}`));
					}
				});
			},
		);

		req.on("timeout", () => {
			req.destroy();
			reject(new Error("VS Code bridge request timed out"));
		});
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

// ── Tool result helpers ─────────────────────────────────────────────────────

function textResult(text) {
	return { content: [{ type: "text", text: String(text) }], details: {} };
}

// ── Footer status polling ────────────────────────────────────────────────────
// Polls getStatus every 4 seconds and updates pi's footer (Phase 5, issue #6).
// No-op if bridge is unavailable.

let footerInterval = null;

function startFooterPolling(pi) {
	if (footerInterval) return;
	if (typeof pi.setFooterStatus !== "function") return; // pi API not available

	footerInterval = setInterval(async () => {
		try {
			const raw = await callVsCode("getStatus", {});
			const status = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (!status?.activeEditor) return;

			const { filePath, languageId, cursor, isDirty, diagnostics } = status.activeEditor;
			const diag = diagnostics ?? {};
			const errors = diag.errors ? ` ✗${diag.errors}` : "";
			const warns = diag.warnings ? ` ⚠${diag.warnings}` : "";
			const dirty = isDirty ? " ●" : "";
			const [line, col] = Array.isArray(cursor) ? cursor : [0, 0];

			pi.setFooterStatus(
				`${filePath}  :${line}  ${languageId}${dirty}${errors}${warns}`,
			);
		} catch {
			// Bridge unavailable — stop polling silently
			clearInterval(footerInterval);
			footerInterval = null;
		}
	}, 4_000);
}

// ── Module export ────────────────────────────────────────────────────────────

module.exports = (pi) => {
	// Start footer polling if pi supports it
	startFooterPolling(pi);

	// ── Original tools (preserved, enhanced) ──────────────────────────────

	pi.registerTool({
		name: "vscode_context",
		label: "VS Code Context",
		description:
			"Get active workspace, active editor, selected text, visible editors, diagnostics, and git diff summary from VS Code.",
		parameters: Type.Object({
			includeDiff: Type.Optional(
				Type.Boolean({ description: "Include git diff summary" }),
			),
			includeDiagnostics: Type.Optional(
				Type.Boolean({ description: "Include VS Code diagnostics" }),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getEditorState", params));
		},
	});

	pi.registerTool({
		name: "vscode_open_file",
		label: "VS Code Open File",
		description:
			"Open a file in VS Code, optionally at a 1-based line/column.",
		parameters: Type.Object({
			path: Type.String({
				description: "Workspace-relative or absolute file path",
			}),
			line: Type.Optional(Type.Number()),
			column: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("openFile", params));
		},
	});

	pi.registerTool({
		name: "vscode_show_diff",
		label: "VS Code Show Diff",
		description:
			"Open VS Code diff viewer for a file against HEAD, or between two explicit paths.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({ description: "Workspace-relative path to diff against HEAD" }),
			),
			left: Type.Optional(Type.String({ description: "Left file URI or path" })),
			right: Type.Optional(Type.String({ description: "Right file URI or path" })),
			title: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("showDiff", params));
		},
	});

	pi.registerTool({
		name: "vscode_command",
		label: "VS Code Command",
		description:
			"Execute any VS Code command by ID. Use carefully — commands can modify editor state.",
		parameters: Type.Object({
			command: Type.String({ description: "VS Code command ID" }),
			argsJson: Type.Optional(
				Type.String({ description: "JSON array of command arguments" }),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("command", params));
		},
	});

	// ── Status & context tools ─────────────────────────────────────────────

	pi.registerTool({
		name: "vscode_get_editor_state",
		label: "VS Code Editor State",
		description:
			"Get a full snapshot of VS Code editor state: workspace folders, active editor, selection, open editors, and optional diagnostics and git diff.",
		parameters: Type.Object({
			includeDiagnostics: Type.Optional(Type.Boolean()),
			includeDiff: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getEditorState", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_latest_selection",
		label: "VS Code Latest Selection",
		description:
			"Get the most recent editor selection, even if focus has moved to the Pi terminal.",
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return textResult(await callVsCode("getLatestSelection", {}));
		},
	});

	pi.registerTool({
		name: "vscode_get_notifications",
		label: "VS Code Notifications",
		description:
			"Poll buffered VS Code workspace events (file saves, editor changes, diagnostics updates) since the last call. Clears the buffer after returning.",
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return textResult(await callVsCode("getNotifications", {}));
		},
	});

	pi.registerTool({
		name: "vscode_report_context_usage",
		label: "Report Context Usage",
		description:
			"Report current context window token usage to the VS Code sidebar indicator.",
		parameters: Type.Object({
			used: Type.Number({ description: "Tokens used" }),
			total: Type.Number({ description: "Total context window size" }),
		}),
		async execute(_id, params) {
			return textResult(
				await callVsCode("reportContextUsage", params),
			);
		},
	});
};
