/**
 * piVscodeTools.js — Pi-side bridge extension
 *
 * Loaded by pi via --extension flag. Registers all VS Code bridge tools
 * that call back to the HTTP bridge server in the extension host.
 *
 * Environment variables set by the extension:
 *   PI_VSCODE_BRIDGE_URL   e.g. http://127.0.0.1:54321
 *   PI_VSCODE_BRIDGE_TOKEN 48-char hex security token
 *
 * All positions (line, character) are 1-based in this API.
 */

const http = require("node:http");
const https = require("node:https");
const { Type } = require("typebox");
const { startEventBridge } = require("./piEventBridge");

// ── HTTP bridge call ─────────────────────────────────────────────────────────

function callVsCode(action, payload) {
	const rawUrl = process.env.PI_VSCODE_BRIDGE_URL || "";
	const token = process.env.PI_VSCODE_BRIDGE_TOKEN || "";
	if (!rawUrl || !token)
		throw new Error(
			"VS Code bridge unavailable. Start Pi from the Pi Sidebar extension.",
		);

	const url = new URL("/bridge", rawUrl);
	const body = JSON.stringify({ token, action, payload });
	const lib = url.protocol === "https:" ? https : http;

	return new Promise((resolve, reject) => {
		const req = lib.request(
			{
				hostname: url.hostname,
				port: url.port
					? Number(url.port)
					: url.protocol === "https:"
						? 443
						: 80,
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
				res.on("data", (chunk) => {
					data += chunk;
				});
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

function textResult(text) {
	return { content: [{ type: "text", text: String(text) }], details: {} };
}

// ── Shared schema fragments ─────────────────────────────────────────────────

const FilePathParam = Type.String({
	description: "Workspace-relative or absolute file path",
});

const LineParam = Type.Number({
	description: "1-based line number",
});

const CharacterParam = Type.Number({
	description: "1-based character/column offset",
});

const RangeParam = Type.Object(
	{
		start: Type.Object({ line: LineParam, character: CharacterParam }),
		end: Type.Object({ line: LineParam, character: CharacterParam }),
	},
	{ description: "1-based range (start inclusive, end exclusive)" },
);

// ── Footer polling (Phase 5 / issue #6) ─────────────────────────────────────

let _footerInterval = null;

/**
 * Poll vscode_get_status every 4 seconds and push the result to pi's
 * TUI footer bar. Stops cleanly if the bridge becomes unreachable.
 * No-op if:
 *   - Bridge env vars are absent (running pi outside VS Code)
 *   - pi does not expose setFooterStatus
 */
function startFooterPolling(pi) {
	// Guard: bridge env vars must be set
	if (!process.env.PI_VSCODE_BRIDGE_URL || !process.env.PI_VSCODE_BRIDGE_TOKEN)
		return;
	// Guard: pi must expose the footer API
	if (typeof pi.setFooterStatus !== "function") return;
	if (_footerInterval) return;

	_footerInterval = setInterval(async () => {
		try {
			const raw = await callVsCode("getStatus", {});
			const status = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (!status?.activeEditor) return;

			const { filePath, languageId, cursor, isDirty, diagnostics } =
				status.activeEditor;
			const diag = diagnostics ?? {};
			const errors = diag.errors ? ` ✗${diag.errors}` : "";
			const warns = diag.warnings ? ` ⚠${diag.warnings}` : "";
			const dirty = isDirty ? " ●" : "";
			const [line, col] = Array.isArray(cursor) ? cursor : [0, 0];

			// Format: "src/extension.ts  :142:5  typescript  ● ✗2 ⚠1"
			pi.setFooterStatus(
				`${filePath}  :${line}:${col}  ${languageId}${dirty}${errors}${warns}`,
			);
		} catch {
			// Bridge unavailable — stop polling silently
			clearInterval(_footerInterval);
			_footerInterval = null;
		}
	}, 4_000);

	// Clean up on process exit
	process.once("exit", () => {
		if (_footerInterval) clearInterval(_footerInterval);
	});
}

// ── Model switch polling ─────────────────────────────────────────────────────

let _modelPollInterval = null;

/**
 * Poll getPendingModelSwitch every 2s. When a switch is queued by the
 * sidebar, call pi.setModel(model) in-place, then report the result back.
 * No-op if bridge env vars are absent.
 */
function startModelSwitchPolling(pi, terminalId) {
	if (!process.env.PI_VSCODE_BRIDGE_URL || !process.env.PI_VSCODE_BRIDGE_TOKEN) return;
	if (!terminalId) return;
	if (_modelPollInterval) return;

	_modelPollInterval = setInterval(async () => {
		try {
			const raw = await callVsCode("getPendingModelSwitch", { terminalId });
			const data = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (!data || !data.model) return;

			const model = data.model;
			let success = false;
			try {
				if (typeof pi.setModel === "function") {
					const result = await pi.setModel(model);
					success = result !== false;
				}
			} catch {
				success = false;
			}

			// Report result back to the bridge (triggers onTabUpdated callback)
			await callVsCode("reportModelChanged", { terminalId, model, success }).catch(() => {});

			// If pi.setModel failed, inject the slash command as a fallback
			if (!success && typeof pi.sendUserMessage === "function") {
				try {
					await pi.sendUserMessage(`/model ${model}`, { deliverAs: "followUp" });
				} catch {
					// best-effort
				}
			}
		} catch {
			// Bridge unavailable — stop silently
			clearInterval(_modelPollInterval);
			_modelPollInterval = null;
		}
	}, 2_000);

	process.once("exit", () => {
		if (_modelPollInterval) clearInterval(_modelPollInterval);
	});
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = (pi) => {
	startFooterPolling(pi);

	// ══════════════════════════════════════════════════════════════════════════
	// ORIGINAL TOOLS (backwards-compatible aliases)
	// ══════════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "vscode_context",
		label: "VS Code Context",
		description:
			"Get active workspace, active editor, selected text, visible editors, optional diagnostics and git diff from VS Code.",
		parameters: Type.Object({
			includeDiff: Type.Optional(
				Type.Boolean({ description: "Include git diff summary" }),
			),
			includeDiagnostics: Type.Optional(
				Type.Boolean({ description: "Include workspace diagnostics" }),
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
			"Open a file in VS Code, optionally revealing a specific line and column.",
		parameters: Type.Object({
			path: FilePathParam,
			line: Type.Optional(LineParam),
			column: Type.Optional(CharacterParam),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("openFile", params));
		},
	});

	pi.registerTool({
		name: "vscode_show_diff",
		label: "VS Code Diff",
		description:
			"Open VS Code diff viewer for a file against HEAD, or between two explicit paths.",
		parameters: Type.Object({
			path: Type.Optional(FilePathParam),
			left: Type.Optional(
				Type.String({ description: "Left file URI or path" }),
			),
			right: Type.Optional(
				Type.String({ description: "Right file URI or path" }),
			),
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
			"Execute any VS Code command by ID. Use with care — commands can modify editor state.",
		parameters: Type.Object({
			command: Type.String({
				description: "VS Code command ID, e.g. editor.action.rename",
			}),
			argsJson: Type.Optional(
				Type.String({ description: "JSON array of command arguments" }),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("command", params));
		},
	});

	// ══════════════════════════════════════════════════════════════════════════
	// EDITOR STATE
	// ══════════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "vscode_get_editor_state",
		label: "VS Code Editor State",
		description:
			"Full snapshot: workspace folders, active editor metadata, cursor, selection, open editors. Optionally include diagnostics and git diff.",
		parameters: Type.Object({
			includeDiagnostics: Type.Optional(Type.Boolean()),
			includeDiff: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getEditorState", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_selection",
		label: "VS Code Selection",
		description:
			"Current editor selection: file path, coordinates, and selected text. Falls back to latest cached selection when the terminal has focus.",
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return textResult(await callVsCode("getSelection", {}));
		},
	});

	pi.registerTool({
		name: "vscode_get_latest_selection",
		label: "VS Code Latest Selection",
		description:
			"Most recent cached selection, even if focus has moved away from the editor to the Pi terminal.",
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return textResult(await callVsCode("getLatestSelection", {}));
		},
	});

	pi.registerTool({
		name: "vscode_get_open_editors",
		label: "VS Code Open Editors",
		description:
			"List all currently visible/open text editors with file path, language ID, dirty state, and active flag.",
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return textResult(await callVsCode("getOpenEditors", {}));
		},
	});

	pi.registerTool({
		name: "vscode_get_workspace_folders",
		label: "VS Code Workspace Folders",
		description:
			"List all workspace folders open in the current VS Code window.",
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return textResult(await callVsCode("getWorkspaceFolders", {}));
		},
	});

	// ══════════════════════════════════════════════════════════════════════════
	// DIAGNOSTICS
	// ══════════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "vscode_get_diagnostics",
		label: "VS Code Diagnostics",
		description:
			"Get LSP / lint / type-check errors and warnings. Pass filePath for a single file, or omit for the whole workspace.",
		parameters: Type.Object({
			filePath: Type.Optional(FilePathParam),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getDiagnostics", params));
		},
	});

	// ══════════════════════════════════════════════════════════════════════════
	// LSP NAVIGATION
	// ══════════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "vscode_get_document_symbols",
		label: "VS Code Document Symbols",
		description:
			"File outline / symbol tree from the active language server (functions, classes, variables, etc.).",
		parameters: Type.Object({
			filePath: FilePathParam,
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getDocumentSymbols", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_definitions",
		label: "VS Code Go to Definition",
		description:
			"Get definition location(s) for the symbol at a given file position.",
		parameters: Type.Object({
			filePath: FilePathParam,
			line: LineParam,
			character: CharacterParam,
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getDefinitions", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_type_definitions",
		label: "VS Code Type Definition",
		description:
			"Get type definition location(s) for the symbol at a given file position.",
		parameters: Type.Object({
			filePath: FilePathParam,
			line: LineParam,
			character: CharacterParam,
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getTypeDefinitions", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_implementations",
		label: "VS Code Implementations",
		description:
			"Get all concrete implementation locations for an interface or abstract member at a given position.",
		parameters: Type.Object({
			filePath: FilePathParam,
			line: LineParam,
			character: CharacterParam,
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getImplementations", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_references",
		label: "VS Code References",
		description: "Find all references to the symbol at a given file position.",
		parameters: Type.Object({
			filePath: FilePathParam,
			line: LineParam,
			character: CharacterParam,
			includeDeclaration: Type.Optional(
				Type.Boolean({
					description:
						"Include the declaration itself in results (default true)",
				}),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getReferences", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_hover",
		label: "VS Code Hover",
		description:
			"Get hover information (type signature, documentation, inferred types) from the language server at a file position.",
		parameters: Type.Object({
			filePath: FilePathParam,
			line: LineParam,
			character: CharacterParam,
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getHover", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_workspace_symbols",
		label: "VS Code Workspace Symbols",
		description:
			"Search for symbols across the entire workspace by name. Returns up to 100 results.",
		parameters: Type.Object({
			query: Type.String({
				description: "Symbol name or prefix to search for",
			}),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getWorkspaceSymbols", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_code_actions",
		label: "VS Code Code Actions",
		description:
			"Get available quick fixes and refactors for a range in a file. Returns an indexed list. Use vscode_execute_code_action to apply one by index.",
		parameters: Type.Object({
			filePath: FilePathParam,
			range: RangeParam,
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("getCodeActions", params));
		},
	});

	// ══════════════════════════════════════════════════════════════════════════
	// ACTION TOOLS
	// ══════════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "vscode_save_document",
		label: "VS Code Save",
		description: "Save a file in VS Code.",
		parameters: Type.Object({
			filePath: FilePathParam,
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("saveDocument", params));
		},
	});

	pi.registerTool({
		name: "vscode_apply_workspace_edit",
		label: "VS Code Workspace Edit",
		description:
			"Apply one or more text edits or file renames across the workspace atomically. Each edit needs a uri and either a range+newText (text edit) or a newUri (file rename).",
		parameters: Type.Object({
			edits: Type.Array(
				Type.Object({
					uri: Type.String({
						description: "Workspace-relative or absolute file path",
					}),
					range: Type.Optional(RangeParam),
					newText: Type.Optional(
						Type.String({ description: "Replacement text (use with range)" }),
					),
					newUri: Type.Optional(
						Type.String({ description: "New path for rename/move operations" }),
					),
				}),
				{ description: "Array of edits to apply atomically" },
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("applyWorkspaceEdit", params));
		},
	});

	pi.registerTool({
		name: "vscode_format_document",
		label: "VS Code Format Document",
		description: "Format an entire file using the active language formatter.",
		parameters: Type.Object({
			filePath: FilePathParam,
			tabSize: Type.Optional(
				Type.Number({ description: "Tab size (default 2)" }),
			),
			insertSpaces: Type.Optional(
				Type.Boolean({
					description: "Use spaces instead of tabs (default true)",
				}),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("formatDocument", params));
		},
	});

	pi.registerTool({
		name: "vscode_format_range",
		label: "VS Code Format Range",
		description:
			"Format a selection/range within a file using the active language formatter.",
		parameters: Type.Object({
			filePath: FilePathParam,
			range: RangeParam,
			tabSize: Type.Optional(
				Type.Number({ description: "Tab size (default 2)" }),
			),
			insertSpaces: Type.Optional(
				Type.Boolean({ description: "Use spaces (default true)" }),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("formatRange", params));
		},
	});

	pi.registerTool({
		name: "vscode_execute_code_action",
		label: "VS Code Execute Code Action",
		description:
			"Apply a code action (quick fix or refactor) by index. First call vscode_get_code_actions to get the list and choose the index.",
		parameters: Type.Object({
			filePath: FilePathParam,
			range: RangeParam,
			index: Type.Number({
				description: "0-based index from vscode_get_code_actions result",
			}),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("executeCodeAction", params));
		},
	});

	pi.registerTool({
		name: "vscode_show_notification",
		label: "VS Code Notification",
		description: "Show an info, warning, or error notification in VS Code.",
		parameters: Type.Object({
			message: Type.String({ description: "Notification text" }),
			level: Type.Optional(
				Type.Union(
					[
						Type.Literal("info"),
						Type.Literal("warning"),
						Type.Literal("error"),
					],
					{
						description: "Severity level (default: info)",
					},
				),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("showNotification", params));
		},
	});

	pi.registerTool({
		name: "vscode_get_notifications",
		label: "VS Code Event Notifications",
		description:
			"Poll buffered VS Code workspace events since the last call: file saves, editor switches, diagnostics changes, dirty state. Clears the buffer after returning.",
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return textResult(await callVsCode("getNotifications", {}));
		},
	});

	// ── Session file reporting ────────────────────────────────────────────────
	const terminalId = process.env.PI_VSCODE_TERMINAL_ID || "";
	if (terminalId && typeof pi.onSessionFile === "function") {
		pi.onSessionFile((sessionFile) => {
			callVsCode("reportTerminalSession", { terminalId, sessionFile }).catch(
				() => {},
			);
		});
	}

	// ── Model switch polling ─────────────────────────────────────────────────
	startModelSwitchPolling(pi, terminalId);

	// ── Agent lifecycle event bridge ─────────────────────────────────────────
	startEventBridge(callVsCode, pi, terminalId);

	// ── Model selection reverse-sync ─────────────────────────────────────────
	// When the user types /model in the TUI, notify the sidebar immediately.
	pi.on("model_select", async (event) => {
		if (!terminalId) return;
		const modelName = event?.model?.id || event?.model?.name || String(event?.model ?? "");
		if (!modelName) return;
		await callVsCode("reportModelChanged", {
			terminalId,
			model: modelName,
			success: true,
		}).catch(() => {});
	});

	pi.registerTool({
		name: "vscode_report_context_usage",
		label: "Report Context Usage",
		description:
			"Report current context window token usage to the VS Code sidebar indicator (used and total token counts).",
		parameters: Type.Object({
			used: Type.Number({ description: "Tokens used so far" }),
			total: Type.Number({ description: "Total context window capacity" }),
		}),
		async execute(_id, params) {
			// Auto-inject terminalId so the bridge can route to the right tab
			const payload = terminalId ? { ...params, terminalId } : params;
			return textResult(await callVsCode("reportContextUsage", payload));
		},
	});
};
