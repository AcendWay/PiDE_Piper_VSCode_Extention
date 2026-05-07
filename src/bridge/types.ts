import type * as vscode from "vscode";

/** A buffered event from VS Code pushed to pi via the notification system. */
export type BridgeEvent =
	| { type: "selection"; data: SelectionInfo }
	| { type: "activeEditor"; data: EditorInfo }
	| { type: "diagnostics"; data: DiagnosticSummary }
	| { type: "documentSaved"; data: { filePath: string } }
	| { type: "documentDirty"; data: { filePath: string; isDirty: boolean } };

export interface SelectionInfo {
	filePath: string;
	fileUri: string;
	languageId: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	selectedText: string;
}

export interface EditorInfo {
	filePath: string;
	fileUri: string;
	languageId: string;
	isDirty: boolean;
	isActive: boolean;
}

export interface DiagnosticSummary {
	errors: number;
	warnings: number;
	infos: number;
	hints: number;
}

export interface BridgeRequest {
	token: string;
	action: string;
	payload?: unknown;
}

export interface BridgeResponse {
	ok: boolean;
	result?: unknown;
	error?: string;
}

/** Model option reported by the live pi session. */
export interface BridgeModelOption {
	/** Canonical selector value, e.g. "openai/gpt-5.5". */
	value: string;
	provider: string;
	id: string;
	name?: string;
	label: string;
	description?: string;
	reasoning?: boolean;
	images?: boolean;
}

/** Serialised diagnostic entry returned by getContext / getDiagnostics. */
export interface DiagnosticEntry {
	file: string;
	line: number;
	severity: vscode.DiagnosticSeverity;
	message: string;
}
