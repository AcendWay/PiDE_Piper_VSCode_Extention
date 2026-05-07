import * as vscode from "vscode";
import { pushNotification } from "./state";
import type { BridgeState } from "./state";
import type { DiagnosticSummary, EditorInfo, SelectionInfo } from "./types";

/**
 * Register all VS Code event listeners that feed the notification ring buffer
 * and keep latestSelection up-to-date.
 *
 * Call once during extension activation, after the bridge state is created.
 * All disposables are added to context.subscriptions.
 */
export function registerBridgeListeners(
	context: vscode.ExtensionContext,
	state: BridgeState,
): void {
	// ── Selection caching + notification ─────────────────────────────────────
	// onDidChangeTextEditorSelection fires on every cursor move. We always
	// update latestSelection immediately, but only push a notification when
	// the selection range itself changes (not just the cursor blinking).
	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection((e) => {
			const sel = captureSelection(e.textEditor);
			if (!sel) return;

			// Always cache the latest selection for vscode_get_latest_selection
			state.latestSelection = sel;

			// Only push a notification if the selection text or range changed
			if (sel.selectedText || hasRangeChanged(state, sel)) {
				pushNotification(state, { type: "selection", data: sel });
			}
		}),
	);

	// ── Active editor change ──────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (!editor) return;

			// Keep latestSelection current when switching files
			const sel = captureSelection(editor);
			if (sel) state.latestSelection = sel;

			const info = captureEditorInfo(editor);
			pushNotification(state, { type: "activeEditor", data: info });
		}),
	);

	// ── Diagnostics change ────────────────────────────────────────────────────
	// Fires for each file whose diagnostics changed. We push a summary for
	// the active editor only (to avoid flooding with background lint events).
	let diagDebounce: ReturnType<typeof setTimeout> | undefined;
	context.subscriptions.push(
		vscode.languages.onDidChangeDiagnostics((e) => {
			clearTimeout(diagDebounce);
			diagDebounce = setTimeout(() => {
				const active = vscode.window.activeTextEditor;
				if (!active) return;

				// Only push if the active file was one of the changed URIs
				const activeStr = active.document.uri.toString();
				const affected = e.uris.some((u) => u.toString() === activeStr);
				if (!affected) return;

				const summary = buildDiagnosticSummary(
					vscode.languages.getDiagnostics(active.document.uri),
				);
				pushNotification(state, {
					type: "diagnostics",
					data: summary,
				});
			}, 500); // 500 ms debounce — diagnostics can fire rapidly during typing
		}),
	);

	// ── Document saved ────────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			pushNotification(state, {
				type: "documentSaved",
				data: {
					filePath: vscode.workspace.asRelativePath(doc.uri),
				},
			});
		}),
	);

	// ── Document dirty state change ───────────────────────────────────────────
	// onDidChangeTextDocument fires on every keystroke; we only care about
	// transitions between clean ↔ dirty, so we track the last known state.
	const dirtyCache = new Map<string, boolean>();
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((e) => {
			const key = e.document.uri.toString();
			const isDirty = e.document.isDirty;
			if (dirtyCache.get(key) === isDirty) return; // no state change
			dirtyCache.set(key, isDirty);
			pushNotification(state, {
				type: "documentDirty",
				data: {
					filePath: vscode.workspace.asRelativePath(e.document.uri),
					isDirty,
				},
			});
		}),
	);

	// ── Seed initial selection if an editor is already open ──────────────────
	const initialEditor = vscode.window.activeTextEditor;
	if (initialEditor) {
		const sel = captureSelection(initialEditor);
		if (sel) state.latestSelection = sel;
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function captureSelection(
	editor: vscode.TextEditor,
): SelectionInfo | null {
	if (!editor) return null;
	const sel = editor.selection;
	return {
		filePath: vscode.workspace.asRelativePath(editor.document.uri),
		fileUri: editor.document.uri.toString(),
		languageId: editor.document.languageId,
		startLine: sel.start.line + 1,
		startCharacter: sel.start.character + 1,
		endLine: sel.end.line + 1,
		endCharacter: sel.end.character + 1,
		selectedText: sel.isEmpty ? "" : editor.document.getText(sel),
	};
}

export function captureEditorInfo(editor: vscode.TextEditor): EditorInfo {
	return {
		filePath: vscode.workspace.asRelativePath(editor.document.uri),
		fileUri: editor.document.uri.toString(),
		languageId: editor.document.languageId,
		isDirty: editor.document.isDirty,
		isActive: editor === vscode.window.activeTextEditor,
	};
}

function buildDiagnosticSummary(
	diagnostics: readonly vscode.Diagnostic[],
): DiagnosticSummary {
	const s: DiagnosticSummary = { errors: 0, warnings: 0, infos: 0, hints: 0 };
	for (const d of diagnostics) {
		if (d.severity === vscode.DiagnosticSeverity.Error) s.errors++;
		else if (d.severity === vscode.DiagnosticSeverity.Warning) s.warnings++;
		else if (d.severity === vscode.DiagnosticSeverity.Information) s.infos++;
		else s.hints++;
	}
	return s;
}

/** Returns true if the cursor/range has meaningfully moved since the last cached selection. */
function hasRangeChanged(state: BridgeState, next: SelectionInfo): boolean {
	const prev = state.latestSelection;
	if (!prev || prev.fileUri !== next.fileUri) return true;
	return (
		prev.startLine !== next.startLine ||
		prev.startCharacter !== next.startCharacter ||
		prev.endLine !== next.endLine ||
		prev.endCharacter !== next.endCharacter
	);
}
