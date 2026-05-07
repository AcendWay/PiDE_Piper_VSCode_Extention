import * as path from "node:path";
import * as vscode from "vscode";
import type { BridgeState } from "./state";
import type { DiagnosticEntry } from "./types";

/**
 * Dispatch a bridge action to the appropriate handler.
 * Full 20+ tool surface covering LSP inspection, code actions,
 * workspace edits, formatting, and document management.
 */
export async function handleBridgeAction(
	action: string,
	payload: unknown,
	state: BridgeState,
	context: vscode.ExtensionContext,
): Promise<unknown> {
	const p = (payload ?? {}) as Record<string, unknown>;

	switch (action) {
		// ── Original tools (preserved for backwards-compat) ───────────────
		case "context":
		case "getEditorState":
			return getEditorState(p, state);
		case "openFile":
			return openFile(p, context);
		case "showDiff":
			return showDiff(p, context);
		case "command":
			return executeCommand(p);

		// ── Status / context reporting ────────────────────────────────────
		case "getStatus":
			return getStatus(state);
		case "getContextUsage":
			return state.contextUsage;
		case "reportContextUsage": {
			state.contextUsage = {
				used: Number(p.used ?? 0),
				total: Number(p.total ?? 0),
			};
			return { received: true };
		}

		// ── Session reporting ─────────────────────────────────────────────
		case "reportTerminalSession": {
			const terminalId = String(p.terminalId ?? "");
			const sessionFile = String(p.sessionFile ?? "");
			if (terminalId && sessionFile)
				state.reportTerminalSession(terminalId, sessionFile);
			return { received: true };
		}

		// ── Notifications ─────────────────────────────────────────────────
		case "getNotifications": {
			const events = [...state.notifications];
			state.notifications = [];
			return events;
		}
		case "clearNotifications":
			state.notifications = [];
			return { cleared: true };

		// ── Selection ─────────────────────────────────────────────────────
		case "getLatestSelection":
			return state.latestSelection;
		case "getSelection":
			return getCurrentSelection(state);

		// ── Editor inspection ─────────────────────────────────────────────
		case "getOpenEditors":
			return getOpenEditors();
		case "getWorkspaceFolders":
			return vscode.workspace.workspaceFolders?.map((f) => ({
				name: f.name,
				path: f.uri.fsPath,
			})) ?? [];
		case "getDiagnostics":
			return getDiagnostics(p, context);

		// ── LSP inspection ────────────────────────────────────────────────
		case "getDocumentSymbols":
			return getDocumentSymbols(p, context);
		case "getDefinitions":
			return getLspLocations("vscode.executeDefinitionProvider", p, context);
		case "getTypeDefinitions":
			return getLspLocations(
				"vscode.executeTypeDefinitionProvider",
				p,
				context,
			);
		case "getImplementations":
			return getLspLocations(
				"vscode.executeImplementationProvider",
				p,
				context,
			);
		case "getDeclarations":
			return getLspLocations(
				"vscode.executeDeclarationProvider",
				p,
				context,
			);
		case "getReferences":
			return getReferences(p, context);
		case "getHover":
			return getHover(p, context);
		case "getWorkspaceSymbols":
			return getWorkspaceSymbols(p);
		case "getCodeActions":
			return getCodeActions(p, context);

		// ── Action tools ──────────────────────────────────────────────────
		case "saveDocument":
			return saveDocument(p, context);
		case "applyWorkspaceEdit":
			return applyWorkspaceEdit(p, context);
		case "formatDocument":
			return formatDocument(p, context);
		case "formatRange":
			return formatRange(p, context);
		case "executeCodeAction":
			return executeCodeAction(p, context);
		case "showNotification":
			return showNotification(p);

		default:
			throw new Error(`Unknown bridge action: ${action}`);
	}
}

// ── Existing handlers (unchanged) ─────────────────────────────────────────

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
					filePath: vscode.workspace.asRelativePath(active.document.uri),
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
	const editor = await vscode.window.showTextDocument(doc, { preview: false });
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
		payload.title ?? `${vscode.workspace.asRelativePath(file)} ↔ HEAD`,
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

// ── New inspection handlers ────────────────────────────────────────────────

function getCurrentSelection(state: BridgeState): unknown {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return state.latestSelection ?? null;
	const sel = editor.selection;
	return {
		filePath: vscode.workspace.asRelativePath(editor.document.uri),
		fileUri: editor.document.uri.toString(),
		languageId: editor.document.languageId,
		startLine: sel.start.line + 1,
		startCharacter: sel.start.character + 1,
		endLine: sel.end.line + 1,
		endCharacter: sel.end.character + 1,
		selectedText: editor.selection.isEmpty
			? ""
			: editor.document.getText(editor.selection),
	};
}

function getOpenEditors(): unknown {
	return vscode.window.visibleTextEditors.map((e) => ({
		filePath: vscode.workspace.asRelativePath(e.document.uri),
		fileUri: e.document.uri.toString(),
		languageId: e.document.languageId,
		isDirty: e.document.isDirty,
		isActive: e === vscode.window.activeTextEditor,
	}));
}

function getDiagnostics(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): unknown {
	if (payload.filePath) {
		const uri = resolveUri(String(payload.filePath), context);
		return vscode.languages.getDiagnostics(uri).map((d) => serializeDiag(d, uri));
	}
	// Whole workspace
	return vscode.languages
		.getDiagnostics()
		.flatMap(([uri, ds]) =>
			ds.slice(0, 50).map((d) => serializeDiag(d, uri)),
		)
		.slice(0, 500);
}

async function getDocumentSymbols(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<unknown> {
	const uri = resolveFileUri(payload, context);
	const symbols = await vscode.commands.executeCommand<
		vscode.DocumentSymbol[] | vscode.SymbolInformation[]
	>("vscode.executeDocumentSymbolProvider", uri);
	if (!symbols?.length) return [];
	return symbols.map(serializeSymbol);
}

async function getLspLocations(
	command: string,
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<unknown> {
	const uri = resolveFileUri(payload, context);
	const pos = resolvePosition(payload);
	const locs = await vscode.commands.executeCommand<
		vscode.Location[] | vscode.LocationLink[]
	>(command, uri, pos);
	if (!locs?.length) return [];
	return locs.map((l) => serializeLocation(l));
}

async function getReferences(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<unknown> {
	const uri = resolveFileUri(payload, context);
	const pos = resolvePosition(payload);
	const includeDecl = payload.includeDeclaration !== false;
	const locs = await vscode.commands.executeCommand<vscode.Location[]>(
		"vscode.executeReferenceProvider",
		uri,
		pos,
		{ includeDeclaration: includeDecl },
	);
	if (!locs?.length) return [];
	return locs.map((l) => serializeLocation(l));
}

async function getHover(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<unknown> {
	const uri = resolveFileUri(payload, context);
	const pos = resolvePosition(payload);
	const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
		"vscode.executeHoverProvider",
		uri,
		pos,
	);
	if (!hovers?.length) return null;
	const contents = hovers.flatMap((h) =>
		h.contents.map((c) =>
			typeof c === "string"
				? c
				: c instanceof vscode.MarkdownString
					? c.value
					: (c as { value: string }).value,
		),
	);
	return { contents, range: hovers[0]?.range ? serializeRange(hovers[0].range) : null };
}

async function getWorkspaceSymbols(
	payload: Record<string, unknown>,
): Promise<unknown> {
	const query = String(payload.query ?? "");
	const symbols = await vscode.commands.executeCommand<
		vscode.SymbolInformation[]
	>("vscode.executeWorkspaceSymbolProvider", query);
	if (!symbols?.length) return [];
	return symbols.slice(0, 100).map(serializeSymbol);
}

async function getCodeActions(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<unknown> {
	const uri = resolveFileUri(payload, context);
	const range = resolveRange(payload);
	const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
		"vscode.executeCodeActionProvider",
		uri,
		range,
	);
	if (!actions?.length) return [];
	return actions.map((a, i) => ({
		index: i,
		title: a.title,
		kind: a.kind?.value,
		isPreferred: a.isPreferred ?? false,
		disabled: a.disabled?.reason,
		hasEdit: !!a.edit,
		hasCommand: !!a.command,
	}));
}

// ── New action handlers ────────────────────────────────────────────────────

async function saveDocument(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<string> {
	const uri = resolveUri(String(payload.filePath ?? ""), context);
	const doc = vscode.workspace.textDocuments.find(
		(d) => d.uri.toString() === uri.toString(),
	);
	if (!doc) {
		// Open then save
		const opened = await vscode.workspace.openTextDocument(uri);
		await opened.save();
		return `Saved ${vscode.workspace.asRelativePath(uri)}`;
	}
	const saved = await doc.save();
	return saved
		? `Saved ${vscode.workspace.asRelativePath(uri)}`
		: `No changes to save in ${vscode.workspace.asRelativePath(uri)}`;
}

async function applyWorkspaceEdit(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<string> {
	const editsRaw = payload.edits as Array<{
		uri: string;
		range?: { start: { line: number; character: number }; end: { line: number; character: number } };
		newText: string;
		newUri?: string; // for renames
	}>;
	if (!Array.isArray(editsRaw) || editsRaw.length === 0)
		throw new Error("applyWorkspaceEdit requires non-empty edits array");

	const wsEdit = new vscode.WorkspaceEdit();
	for (const e of editsRaw) {
		const uri = resolveUri(e.uri, context);
		if (e.newUri) {
			// Rename / move
			wsEdit.renameFile(uri, resolveUri(e.newUri, context));
		} else if (e.range) {
			const range = new vscode.Range(
				new vscode.Position(
					Math.max(0, e.range.start.line - 1),
					Math.max(0, e.range.start.character - 1),
				),
				new vscode.Position(
					Math.max(0, e.range.end.line - 1),
					Math.max(0, e.range.end.character - 1),
				),
			);
			wsEdit.replace(uri, range, e.newText);
		} else {
			throw new Error("Each edit requires either a range+newText or newUri");
		}
	}

	const applied = await vscode.workspace.applyEdit(wsEdit);
	return applied
		? `Applied ${editsRaw.length} edit(s)`
		: "Workspace edit was rejected";
}

async function formatDocument(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<string> {
	const uri = resolveFileUri(payload, context);
	const options: vscode.FormattingOptions = {
		tabSize: Number(payload.tabSize ?? 2),
		insertSpaces: payload.insertSpaces !== false,
	};
	const textEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
		"vscode.executeFormatDocumentProvider",
		uri,
		options,
	);
	if (!textEdits?.length) return "No formatting changes";
	const wsEdit = new vscode.WorkspaceEdit();
	wsEdit.set(uri, textEdits);
	const applied = await vscode.workspace.applyEdit(wsEdit);
	return applied
		? `Applied ${textEdits.length} formatting edit(s)`
		: "Format edit was rejected";
}

async function formatRange(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<string> {
	const uri = resolveFileUri(payload, context);
	const range = resolveRange(payload);
	const options: vscode.FormattingOptions = {
		tabSize: Number(payload.tabSize ?? 2),
		insertSpaces: payload.insertSpaces !== false,
	};
	const textEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
		"vscode.executeFormatRangeProvider",
		uri,
		range,
		options,
	);
	if (!textEdits?.length) return "No formatting changes for range";
	const wsEdit = new vscode.WorkspaceEdit();
	wsEdit.set(uri, textEdits);
	const applied = await vscode.workspace.applyEdit(wsEdit);
	return applied
		? `Applied ${textEdits.length} range formatting edit(s)`
		: "Range format edit was rejected";
}

async function executeCodeAction(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): Promise<string> {
	const uri = resolveFileUri(payload, context);
	const range = resolveRange(payload);
	const actionIndex = Number(payload.index ?? 0);

	const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
		"vscode.executeCodeActionProvider",
		uri,
		range,
	);
	if (!actions?.length) throw new Error("No code actions available at range");
	const action = actions[actionIndex];
	if (!action)
		throw new Error(
			`Code action index ${actionIndex} out of range (${actions.length} available)`,
		);

	if (action.edit) {
		const applied = await vscode.workspace.applyEdit(action.edit);
		if (!applied) throw new Error("Code action edit was rejected");
	}
	if (action.command) {
		await vscode.commands.executeCommand(
			action.command.command,
			...(action.command.arguments ?? []),
		);
	}
	return `Executed code action: ${action.title}`;
}

async function showNotification(
	payload: Record<string, unknown>,
): Promise<string> {
	const message = String(payload.message ?? "");
	const level = String(payload.level ?? "info");
	if (level === "error") {
		vscode.window.showErrorMessage(message);
	} else if (level === "warning") {
		vscode.window.showWarningMessage(message);
	} else {
		vscode.window.showInformationMessage(message);
	}
	return `Showed ${level} notification`;
}

// ── Serialisation helpers ─────────────────────────────────────────────────

function serializeRange(r: vscode.Range) {
	return {
		start: { line: r.start.line + 1, character: r.start.character + 1 },
		end: { line: r.end.line + 1, character: r.end.character + 1 },
	};
}

function serializeLocation(
	loc: vscode.Location | vscode.LocationLink,
): unknown {
	if ("targetUri" in loc) {
		return {
			filePath: vscode.workspace.asRelativePath(loc.targetUri),
			fileUri: loc.targetUri.toString(),
			range: serializeRange(loc.targetRange),
		};
	}
	return {
		filePath: vscode.workspace.asRelativePath(loc.uri),
		fileUri: loc.uri.toString(),
		range: serializeRange(loc.range),
	};
}

function serializeSymbol(
	sym: vscode.DocumentSymbol | vscode.SymbolInformation,
): unknown {
	if ("children" in sym) {
		// DocumentSymbol
		return {
			name: sym.name,
			kind: vscode.SymbolKind[sym.kind],
			detail: sym.detail,
			range: serializeRange(sym.range),
			selectionRange: serializeRange(sym.selectionRange),
			children: sym.children.map(serializeSymbol),
		};
	}
	// SymbolInformation
	return {
		name: sym.name,
		kind: vscode.SymbolKind[sym.kind],
		containerName: sym.containerName,
		filePath: vscode.workspace.asRelativePath(sym.location.uri),
		range: serializeRange(sym.location.range),
	};
}

function serializeDiag(
	d: vscode.Diagnostic,
	uri: vscode.Uri,
): Record<string, unknown> {
	return {
		filePath: vscode.workspace.asRelativePath(uri),
		range: serializeRange(d.range),
		severity: vscode.DiagnosticSeverity[d.severity],
		message: d.message,
		source: d.source,
		code: typeof d.code === "object" ? d.code?.value : d.code,
	};
}

// ── Resolve helpers ────────────────────────────────────────────────────────

function resolveUri(
	input: string,
	context: vscode.ExtensionContext,
): vscode.Uri {
	if (!input) throw new Error("Missing file path");
	if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return vscode.Uri.parse(input);
	if (path.isAbsolute(input)) return vscode.Uri.file(input);
	const folder =
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath;
	return vscode.Uri.file(path.join(folder, input));
}

/** Resolve a file URI from payload.filePath or payload.path */
function resolveFileUri(
	payload: Record<string, unknown>,
	context: vscode.ExtensionContext,
): vscode.Uri {
	const p = String(payload.filePath ?? payload.path ?? "");
	return resolveUri(p, context);
}

/** Resolve a 1-based Position from payload.line / payload.character */
function resolvePosition(payload: Record<string, unknown>): vscode.Position {
	return new vscode.Position(
		Math.max(0, Number(payload.line ?? 1) - 1),
		Math.max(0, Number(payload.character ?? 1) - 1),
	);
}

/**
 * Resolve a Range from payload.
 * Accepts either startLine/startCharacter/endLine/endCharacter
 * or a nested range: { start: {line,character}, end: {line,character} }
 * All values are 1-based.
 */
function resolveRange(payload: Record<string, unknown>): vscode.Range {
	const r = payload.range as
		| { start: { line: number; character: number }; end: { line: number; character: number } }
		| undefined;
	if (r) {
		return new vscode.Range(
			new vscode.Position(Math.max(0, r.start.line - 1), Math.max(0, r.start.character - 1)),
			new vscode.Position(Math.max(0, r.end.line - 1), Math.max(0, r.end.character - 1)),
		);
	}
	return new vscode.Range(
		new vscode.Position(
			Math.max(0, Number(payload.startLine ?? 1) - 1),
			Math.max(0, Number(payload.startCharacter ?? 1) - 1),
		),
		new vscode.Position(
			Math.max(0, Number(payload.endLine ?? 1) - 1),
			Math.max(0, Number(payload.endCharacter ?? 1) - 1),
		),
	);
}

function getDiagnosticSummary(diagnostics: readonly vscode.Diagnostic[]): {
	errors: number;
	warnings: number;
	infos: number;
	hints: number;
} {
	const s = { errors: 0, warnings: 0, infos: 0, hints: 0 };
	for (const d of diagnostics) {
		if (d.severity === vscode.DiagnosticSeverity.Error) s.errors++;
		else if (d.severity === vscode.DiagnosticSeverity.Warning) s.warnings++;
		else if (d.severity === vscode.DiagnosticSeverity.Information) s.infos++;
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
	return JSON.stringify({ branch: repo.state.HEAD?.name, changes }, null, 2);
}
