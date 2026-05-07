import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rewindOneTurn, SessionRewindError } from "../../src/sessionRewind";

// ── Test fixture helpers ──────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rewind-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, lines: object[]): string {
	const p = path.join(tmpDir, name);
	fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
	return p;
}

function readLines(p: string): object[] {
	return fs
		.readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

// A minimal JSONL session with N user turns
function makeSession(userTurns: number): object[] {
	const header = { type: "session", version: 3, id: "sess-001", timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" };
	const entries: object[] = [header];
	let prevId = "sess-001";

	for (let i = 0; i < userTurns; i++) {
		const userId = `user-${i + 1}-id`;
		const asstId = `asst-${i + 1}-id`;
		entries.push({
			type: "message",
			id: userId,
			parentId: prevId,
			timestamp: `2024-01-01T00:0${i}:00.000Z`,
			message: { role: "user", content: `User message ${i + 1}` },
		});
		entries.push({
			type: "message",
			id: asstId,
			parentId: userId,
			timestamp: `2024-01-01T00:0${i}:01.000Z`,
			message: { role: "assistant", content: [{ type: "text", text: `Reply ${i + 1}` }] },
		});
		prevId = asstId;
	}
	return entries;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("rewindOneTurn — happy path", () => {
	it("returns a fork path in the same directory", () => {
		const p = write("session.jsonl", makeSession(2));
		const { forkPath } = rewindOneTurn(p);
		expect(forkPath).toContain(tmpDir);
		expect(forkPath).toContain("-rewind-1.jsonl");
	});

	it("fork file has N-1 user turns for a 2-turn session", () => {
		const p = write("session.jsonl", makeSession(2));
		const { forkPath } = rewindOneTurn(p);
		const forkLines = readLines(forkPath);
		const userMessages = forkLines.filter(
			(l: any) => l.type === "message" && l.message?.role === "user",
		);
		expect(userMessages).toHaveLength(1);
	});

	it("fork file has 0 user turns for a 1-turn session", () => {
		const p = write("session.jsonl", makeSession(1));
		const { forkPath } = rewindOneTurn(p);
		const forkLines = readLines(forkPath);
		const userMessages = forkLines.filter(
			(l: any) => l.type === "message" && l.message?.role === "user",
		);
		expect(userMessages).toHaveLength(0);
	});

	it("fork file contains the header", () => {
		const p = write("session.jsonl", makeSession(2));
		const { forkPath } = rewindOneTurn(p);
		const first = readLines(forkPath)[0] as any;
		expect(first.type).toBe("session");
	});

	it("original file is byte-identical after rewind", () => {
		const orig = makeSession(3);
		const p = write("session.jsonl", orig);
		const beforeBytes = fs.readFileSync(p);
		rewindOneTurn(p);
		const afterBytes = fs.readFileSync(p);
		expect(afterBytes).toEqual(beforeBytes);
	});
});

describe("rewindOneTurn — name collision handling", () => {
	it("increments suffix when rewind-1 already exists", () => {
		const p = write("session.jsonl", makeSession(3));
		// Pre-create the rewind-1 file
		fs.writeFileSync(path.join(tmpDir, "session-rewind-1.jsonl"), "{}");

		const { forkPath } = rewindOneTurn(p);
		expect(forkPath).toContain("-rewind-2.jsonl");
		expect(fs.existsSync(forkPath)).toBe(true);
	});

	it("continues incrementing for multiple collisions", () => {
		const p = write("session.jsonl", makeSession(4));
		fs.writeFileSync(path.join(tmpDir, "session-rewind-1.jsonl"), "{}");
		fs.writeFileSync(path.join(tmpDir, "session-rewind-2.jsonl"), "{}");
		fs.writeFileSync(path.join(tmpDir, "session-rewind-3.jsonl"), "{}");

		const { forkPath } = rewindOneTurn(p);
		expect(forkPath).toContain("-rewind-4.jsonl");
	});
});

describe("rewindOneTurn — error cases", () => {
	it("throws FILE_NOT_FOUND for a missing file", () => {
		expect(() => rewindOneTurn("/nonexistent/path/session.jsonl")).toThrow(
			SessionRewindError,
		);
		try {
			rewindOneTurn("/nonexistent/path/session.jsonl");
		} catch (e) {
			expect((e as SessionRewindError).code).toBe("FILE_NOT_FOUND");
		}
	});

	it("throws MALFORMED_JSON for invalid JSONL content", () => {
		const p = path.join(tmpDir, "bad.jsonl");
		fs.writeFileSync(p, '{"type":"session"}\nnot-valid-json\n');
		expect(() => rewindOneTurn(p)).toThrow(SessionRewindError);
		try {
			rewindOneTurn(p);
		} catch (e) {
			expect((e as SessionRewindError).code).toBe("MALFORMED_JSON");
		}
	});

	it("throws NO_USER_TURNS for a session with only a header", () => {
		const header = { type: "session", version: 3, id: "s", timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" };
		const p = write("empty.jsonl", [header]);
		expect(() => rewindOneTurn(p)).toThrow(SessionRewindError);
		try {
			rewindOneTurn(p);
		} catch (e) {
			expect((e as SessionRewindError).code).toBe("NO_USER_TURNS");
		}
	});

	it("throws NO_USER_TURNS for a session with only assistant messages", () => {
		const entries = [
			{ type: "session", version: 3, id: "s", timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", id: "a1", parentId: "s", timestamp: "2024-01-01T00:00:01Z", message: { role: "assistant", content: [] } },
		];
		const p = write("assistant-only.jsonl", entries);
		expect(() => rewindOneTurn(p)).toThrow(SessionRewindError);
	});
});
