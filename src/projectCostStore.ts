/**
 * projectCostStore.ts
 *
 * Persists project-lifetime cost across VS Code reloads via workspaceState.
 * Self-heals on activation by walking pi's session JSONL files and reconciling
 * against the persisted total.
 *
 * Per the PRD, this module is not unit-tested — it's mostly a thin wrapper
 * over workspaceState plus filesystem walking. Reconciliation is exercised
 * manually.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

export interface ProjectCostTotal {
	totalCost: number;
	totalTokens: number;
	sessionCount: number;
	lastUpdated: string; // ISO
	schemaVersion: 1;
}

const SCHEMA_VERSION = 1;

function key(workspaceRoot: string): string {
	return `piSidebar.projectCost.${workspaceRoot}`;
}

function emptyTotal(): ProjectCostTotal {
	return {
		totalCost: 0,
		totalTokens: 0,
		sessionCount: 0,
		lastUpdated: new Date().toISOString(),
		schemaVersion: SCHEMA_VERSION,
	};
}

export class ProjectCostStore {
	constructor(
		private readonly state: vscode.Memento,
		private readonly workspaceRoot: string,
	) {}

	getTotal(): ProjectCostTotal {
		return this.state.get<ProjectCostTotal>(key(this.workspaceRoot)) ??
			emptyTotal();
	}

	/**
	 * Add an incremental cost + token delta to the running totals.
	 * Negative deltas are clamped to 0.
	 */
	async increment(deltaCost: number, deltaTokens: number): Promise<void> {
		const cur = this.getTotal();
		const next: ProjectCostTotal = {
			totalCost: cur.totalCost + Math.max(0, deltaCost),
			totalTokens: cur.totalTokens + Math.max(0, deltaTokens),
			sessionCount: cur.sessionCount,
			lastUpdated: new Date().toISOString(),
			schemaVersion: SCHEMA_VERSION,
		};
		await this.state.update(key(this.workspaceRoot), next);
	}

	/**
	 * Walk pi's session files for sessions whose `cwd` matches the workspace
	 * root, sum their assistant `usage.cost.total` and total tokens, and set
	 * the persisted total to max(persisted, reconciled). Self-healing.
	 */
	async reconcileFromSessions(sessionsDir?: string): Promise<void> {
		const dir = sessionsDir ?? path.join(os.homedir(), ".pi", "agent", "sessions");
		if (!fs.existsSync(dir)) return;

		let totalCost = 0;
		let totalTokens = 0;
		let sessionCount = 0;

		// pi sessions dir layout:
		//   ~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl
		try {
			const cwdEncoded = this.workspaceRoot.replace(/\//g, "-");
			const subdirs = fs.readdirSync(dir, { withFileTypes: true });
			for (const sd of subdirs) {
				if (!sd.isDirectory()) continue;
				// Match either an exact encoded path or a partial match
				if (
					!sd.name.includes(cwdEncoded) &&
					!sd.name.includes(path.basename(this.workspaceRoot))
				) {
					continue;
				}
				const subPath = path.join(dir, sd.name);
				const sessions = fs.readdirSync(subPath).filter((f) => f.endsWith(".jsonl"));
				for (const session of sessions) {
					const filePath = path.join(subPath, session);
					try {
						const stats = this.summarizeSession(filePath);
						if (stats.matchesWorkspace) {
							totalCost += stats.cost;
							totalTokens += stats.tokens;
							sessionCount++;
						}
					} catch {
						// Ignore unreadable / malformed sessions
					}
				}
			}
		} catch {
			return; // sessions dir inaccessible
		}

		// Take max of persisted vs reconciled (self-heal)
		const cur = this.getTotal();
		const next: ProjectCostTotal = {
			totalCost: Math.max(cur.totalCost, totalCost),
			totalTokens: Math.max(cur.totalTokens, totalTokens),
			sessionCount: Math.max(cur.sessionCount, sessionCount),
			lastUpdated: new Date().toISOString(),
			schemaVersion: SCHEMA_VERSION,
		};
		await this.state.update(key(this.workspaceRoot), next);
	}

	/** Read a session JSONL file and return its cost / token totals. */
	private summarizeSession(filePath: string): {
		matchesWorkspace: boolean;
		cost: number;
		tokens: number;
	} {
		const raw = fs.readFileSync(filePath, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim());

		let matchesWorkspace = false;
		let cost = 0;
		let tokens = 0;

		for (const line of lines) {
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}

			if (entry.type === "session" && typeof entry.cwd === "string") {
				if (entry.cwd === this.workspaceRoot) matchesWorkspace = true;
			}

			if (entry.type === "message") {
				const msg = entry.message as Record<string, unknown> | undefined;
				if (msg?.role === "assistant") {
					const usage = msg.usage as
						| {
								totalTokens?: number;
								cost?: { total?: number };
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
						  }
						| undefined;
					if (usage) {
						cost += usage.cost?.total ?? 0;
						tokens +=
							usage.totalTokens ??
							(usage.input ?? 0) +
								(usage.output ?? 0) +
								(usage.cacheRead ?? 0) +
								(usage.cacheWrite ?? 0);
					}
				}
			}
		}

		return { matchesWorkspace, cost, tokens };
	}

	/**
	 * List recent sessions for this workspace with summary info.
	 * Used by the [history ↗] quick-pick.
	 */
	listRecentSessions(sessionsDir?: string, limit = 50): Array<{
		filePath: string;
		date: string;
		cost: number;
		tokens: number;
	}> {
		const dir = sessionsDir ?? path.join(os.homedir(), ".pi", "agent", "sessions");
		if (!fs.existsSync(dir)) return [];

		const results: Array<{
			filePath: string;
			date: string;
			cost: number;
			tokens: number;
			mtime: number;
		}> = [];

		try {
			const subdirs = fs.readdirSync(dir, { withFileTypes: true });
			for (const sd of subdirs) {
				if (!sd.isDirectory()) continue;
				const subPath = path.join(dir, sd.name);
				const sessions = fs.readdirSync(subPath).filter((f) => f.endsWith(".jsonl"));
				for (const session of sessions) {
					const filePath = path.join(subPath, session);
					try {
						const stat = fs.statSync(filePath);
						const stats = this.summarizeSession(filePath);
						if (!stats.matchesWorkspace) continue;
						results.push({
							filePath,
							date: stat.mtime.toISOString().slice(0, 10),
							cost: stats.cost,
							tokens: stats.tokens,
							mtime: stat.mtimeMs,
						});
					} catch {
						// skip
					}
				}
			}
		} catch {
			return [];
		}

		results.sort((a, b) => b.mtime - a.mtime);
		return results.slice(0, limit).map(({ filePath, date, cost, tokens }) => ({
			filePath,
			date,
			cost,
			tokens,
		}));
	}
}
