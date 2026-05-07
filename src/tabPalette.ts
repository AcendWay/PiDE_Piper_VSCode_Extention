/**
 * tabPalette.ts
 *
 * Pure helpers for Pi tab visual differentiation.
 * No VS Code dependencies in the module itself, but ThemeColor is
 * used in the return type — callers must import from vscode.
 */
import * as vscode from "vscode";

/** Default colour palette cycling for tabs 2+. */
export const DEFAULT_PALETTE = [
	"terminal.ansiCyan",
	"terminal.ansiMagenta",
	"terminal.ansiYellow",
	"terminal.ansiBlue",
	"terminal.ansiGreenBright",
	"terminal.ansiRedBright",
];

/**
 * Return the VS Code ThemeColor for a tab at a given 0-based insertion index.
 * Tab 0 (the first Pi terminal) always returns undefined so it uses the
 * default terminal color.
 *
 * @param index  0-based insertion order of the tab
 * @param palette  Array of VS Code theme color IDs to cycle through
 */
export function tabPalette(
	index: number,
	palette: string[] = DEFAULT_PALETTE,
): vscode.ThemeColor | undefined {
	if (index === 0 || palette.length === 0) return undefined;
	const colorId = palette[(index - 1) % palette.length];
	return new vscode.ThemeColor(colorId);
}

/**
 * Encode a tab label as an OSC 2 escape sequence.
 * Writing this to the terminal's stdout causes VS Code to update the tab title.
 *
 * @param label  The title text (already truncated / sanitised by the caller)
 */
export function tabTitleEncoder(label: string): string {
	// OSC 2 — Operating System Command: set window title
	return `\x1b]2;${label}\x07`;
}

/**
 * Build a terminal display name from an optional user-supplied label
 * and the tab's insertion index.
 *
 * @param label  Optional user-supplied label (will be truncated to 30 chars)
 * @param index  0-based insertion index
 */
export function buildTabName(label: string | undefined, index: number): string {
	if (label && label.trim()) {
		const trimmed = label.trim().slice(0, 30);
		return `Pi Agent · ${trimmed}`;
	}
	if (index === 0) return "Pi Agent";
	return `Pi Agent ${index + 1}`;
}
