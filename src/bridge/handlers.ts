import * as path from "node:path";
import * as vscode from "vscode";
import type { BridgeState } from "./state";
import type { DiagnosticEntry } from "./types";

/**
 * Dispatch a bridge action to the appropriate handler.
 * Phase 1: supports the original 4 tools + new state/reporting actions.
 * Phase 5 will expand this to 20+ LSP tools.
 */
export async function handleBridgeAction(
	action: string,
	payload: unknown,
	state: BridgeState,
	context: vscode.ExtensionContext,
): Promise<unknown> {
	const p = (payload ?? {}) as Record<string, unknown>;

	switch (action) {
		// ── Original tools (preserved as-is) ──────────────────────────────
		case "context":
		case "getEditorState":
			return getEditorState(p, state);

		case "openFile":
			return openFile(p, context);

		case "showDiff":
			return showDiff(p, context);

		case "command":
			return executeCommand(p);

		// ── Context / status ───────────────────────────────────────────────
		case "getStatus":
			return getStatus(state);

		case "getContextUsage":
			return state.contextUsage;

		case "reportContextUsage": {
			const used = Number(p.used ?? 0);
			const total = Number(p.total ?? 0);
			state.contextUsage = { used, total };
			return { received: true };
		}

		// ── Session reporting ──────────────────────────────────────────────
		case "reportTerminalSession": {
			const terminalId = String(p.terminalId ?? "");
			const sessionFile = String(p.sessionFile ?? "");
			if (terminalId && sessionFile) {
				state.reportTerminalSession(terminalId, sessionFile);
			}
			return { received: true };
		}

		// ── Notifications ─────────────────────────────────────────────────
		case "getNotifications": {
			const events = [...state.notifications];
			state.notifications = [];
			return events;
		}

		case "clearNotifications": {
			state.notifications = [];
			return { cleared: true };
		}

		// ── Selection ─────────────────────────────────────────────────────
		case "getLatestSelection":
			return state.latestSelection;

		default:
			throw new Error(`Unknown bridge action: ${action}`);
	}
}

// ── Handler implementations ────────────────────────────────────────────────

async function getEditorState(
	payload: Record<string, unknown>,
	state: BridgeState,
): Promise<unknown> {
	const active = vscode.window.activeTextEditor;
	const visible = vscode.window.visibleTextEditors.map((e) =>
		vscode.workspace.asRelativePath(e.document.uri),
	);

	let diagnostics: DiagnosticEntry[] | undefined;
	if (payload.includeDiagnostics) {
		diagnostics = vscode.languages
			.getDiagnostics()
			.flatMap(([uri, ds]) =>
				ds.slice(0, 20).map((d) => ({
					file: vscode.workspace.asRelativePath(uri),
					line: d.range.start.line + 1,
					severity: d.severity,
					message: d.message,
				})),
			)
			.slice(0, 200);
	}

	const diff = payload.includeDiff ? await gitSummary() : undefined;

	return {
		workspaceFolders:
			vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
		activeEditor: active
			? {
					file: vscode.workspace.asRelativePath(active.document.uri),
					language: active.document.languageId,
					cursor: [
						active.selection.active.line + 1,
						active.selection.active.character + 1,
					],
					selectedText: active.selection.isEmpty
						? ""
						: active.document.getText(active.selection),
					isDirty: active.document.isDirty,
				}
			: null,
		visibleEditors: visible,
		latestSelection: state.latestSelection,
		diagnostics,
		diff,
	};
}

function getStatus(state: BridgeState): unknown {
	const active = vscode.window.activeTextEditor;
	const diagnostics = active
		? getDiagnosticSummary(
				vscode.languages.getDiagnostics(active.document.uri),
			)
		: { errors: 0, warnings: 0, infos: 0, hints: 0 };

	return {
		workspaceFolders:
			vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
		activeEditor: active
			? {
					filePath: vscode.workspace.asRelativePath(
						active.document.uri,
					),
					languageId: active.document.languageId,
					cursor: [
						active.selection.active.line + 1,
						active.selection.active.character + 1,
					],
					isDirty: active.document.isDirty,
				}
			: null,
		latestSelection: state.latestSelection,
		diagnostics,
		contextUsage: state.contextUsage,
	};
}

async function openFile(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<string> {
	const uri = resolveUri(String(payload.path ?? ""), context);
	const doc = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(doc, {
		preview: false,
	});
	if (payload.line) {
		const pos = new vscode.Position(
			Math.max(0, Number(payload.line) - 1),
			Math.max(0, Number(payload.column ?? 1) - 1),
		);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(
			new vscode.Range(pos, pos),
			vscode.TextEditorRevealType.InCenter,
		);
	}
	return `Opened ${vscode.workspace.asRelativePath(uri)}`;
}

async function showDiff(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<string> {
	if (payload.left && payload.right) {
		await vscode.commands.executeCommand(
			"vscode.diff",
			resolveUri(String(payload.left), context),
			resolveUri(String(payload.right), context),
			payload.title ?? "Diff",
		);
		return "Opened explicit diff";
	}
	if (!payload.path) throw new Error("showDiff requires path or left/right");
	const file = resolveUri(String(payload.path), context);
	const left = file.with({
		scheme: "git",
		query: JSON.stringify({ path: file.fsPath, ref: "HEAD" }),
	});
	await vscode.commands.executeCommand(
		"vscode.diff",
		left,
		file,
		payload.title ??
			`${vscode.workspace.asRelativePath(file)} ↔ HEAD`,
	);
	return `Opened diff for ${vscode.workspace.asRelativePath(file)}`;
}

async function executeCommand(
	payload: Record<string, unknown>,
): Promise<unknown> {
	const cmd = String(payload.command ?? "");
	if (!cmd) throw new Error("executeCommand requires command");
	const args = payload.argsJson
		? (JSON.parse(String(payload.argsJson)) as unknown[])
		: [];
	const result = await vscode.commands.executeCommand(cmd, ...args);
	return typeof result === "undefined"
		? `Executed ${cmd}`
		: JSON.stringify(result, null, 2);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveUri(
	input: string,
	context: vscode.ExtensionContext,
): vscode.Uri {
	if (!input) throw new Error("Missing path");
	if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return vscode.Uri.parse(input);
	if (path.isAbsolute(input)) return vscode.Uri.file(input);
	const folder =
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
		context.extensionPath;
	return vscode.Uri.file(path.join(folder, input));
}

function getDiagnosticSummary(
	diagnostics: readonly vscode.Diagnostic[],
): { errors: number; warnings: number; infos: number; hints: number } {
	const s = { errors: 0, warnings: 0, infos: 0, hints: 0 };
	for (const d of diagnostics) {
		if (d.severity === vscode.DiagnosticSeverity.Error) s.errors++;
		else if (d.severity === vscode.DiagnosticSeverity.Warning)
			s.warnings++;
		else if (d.severity === vscode.DiagnosticSeverity.Information)
			s.infos++;
		else s.hints++;
	}
	return s;
}

async function gitSummary(): Promise<string> {
	const git = vscode.extensions
		.getExtension("vscode.git")
		?.exports?.getAPI?.(1);
	const repo = git?.repositories?.[0];
	if (!repo) return "VS Code Git API unavailable or no repository open.";
	const changes = [
		...repo.state.workingTreeChanges,
		...repo.state.indexChanges,
	].map((c: { uri: vscode.Uri; status: number }) => ({
		uri: vscode.workspace.asRelativePath(c.uri),
		status: c.status,
	}));
	return JSON.stringify(
		{ branch: repo.state.HEAD?.name, changes },
		null,
		2,
	);
}
