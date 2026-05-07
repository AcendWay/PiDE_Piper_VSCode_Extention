/**
 * sessionRewind.ts
 *
 * Non-destructive one-turn rewind for Pi Agent session files.
 * Reads a pi JSONL session file, removes the most recent user-turn
 * boundary and everything that follows it, then writes a fork file.
 *
 * Original file is NEVER modified.
 * No VS Code or pi dependencies — fully unit-testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Error types ───────────────────────────────────────────────────────────────

export class SessionRewindError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "FILE_NOT_FOUND"
			| "MALFORMED_JSON"
			| "NO_USER_TURNS",
	) {
		super(message);
		this.name = "SessionRewindError";
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface RewindResult {
	/** Absolute path to the newly written fork file. */
	forkPath: string;
}

/**
 * Rewind one user turn from a pi session file.
 *
 * 1. Reads all JSONL lines from `sessionPath`.
 * 2. Finds the last line with `message.role === "user"`.
 * 3. Writes lines 0..N-1 (everything before the last user message) to a
 *    fork file named `<base>-rewind-<n>.jsonl`.
 * 4. Leaves the original file unchanged.
 *
 * @throws {SessionRewindError} FILE_NOT_FOUND if the file does not exist.
 * @throws {SessionRewindError} MALFORMED_JSON if any line is not valid JSON.
 * @throws {SessionRewindError} NO_USER_TURNS if there are no user messages.
 */
export function rewindOneTurn(sessionPath: string): RewindResult {
	// ── 1. Read file ──────────────────────────────────────────────────────
	if (!fs.existsSync(sessionPath)) {
		throw new SessionRewindError(
			`Session file not found: ${sessionPath}`,
			"FILE_NOT_FOUND",
		);
	}

	const raw = fs.readFileSync(sessionPath, "utf8");
	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	// ── 2. Parse + validate ───────────────────────────────────────────────
	const parsed: unknown[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			parsed.push(JSON.parse(lines[i]));
		} catch {
			throw new SessionRewindError(
				`Malformed JSON on line ${i + 1} of ${sessionPath}`,
				"MALFORMED_JSON",
			);
		}
	}

	// ── 3. Find last user-turn boundary ───────────────────────────────────
	let lastUserIdx = -1;
	for (let i = parsed.length - 1; i >= 0; i--) {
		const entry = parsed[i] as Record<string, unknown>;
		const msg = entry.message as Record<string, unknown> | undefined;
		if (entry.type === "message" && msg?.role === "user") {
			lastUserIdx = i;
			break;
		}
	}

	if (lastUserIdx === -1) {
		throw new SessionRewindError(
			`No user turns found in ${sessionPath} — nothing to rewind.`,
			"NO_USER_TURNS",
		);
	}

	// ── 4. Build fork path (collision-safe) ───────────────────────────────
	const ext = path.extname(sessionPath); // ".jsonl"
	const base = sessionPath.slice(0, sessionPath.length - ext.length);
	const forkPath = findAvailableRewindPath(base, ext);

	// ── 5. Write fork (lines before the last user message) ────────────────
	const keepLines = lines.slice(0, lastUserIdx);
	fs.writeFileSync(forkPath, keepLines.join("\n") + (keepLines.length ? "\n" : ""), "utf8");

	return { forkPath };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Find the first non-existing path of the form `<base>-rewind-<n><ext>`.
 */
function findAvailableRewindPath(base: string, ext: string): string {
	for (let n = 1; n <= 9999; n++) {
		const candidate = `${base}-rewind-${n}${ext}`;
		if (!fs.existsSync(candidate)) return candidate;
	}
	// Extremely unlikely but handle gracefully
	throw new SessionRewindError(
		`Could not find an available rewind path for ${base}*${ext}`,
		"FILE_NOT_FOUND",
	);
}
