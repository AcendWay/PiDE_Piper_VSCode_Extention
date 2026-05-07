import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Bridge } from "./bridge/server";
import { createPiTerminal } from "./terminal";

const SESSIONS_KEY = "piSidebar.terminalSessions";

interface SessionEntry {
	terminalId: string;
	sessionFile: string;
}

export class SessionTracker {
	private terminalIds = new WeakMap<vscode.Terminal, string>();

	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Called by bridge when pi reports its session file. */
	track(terminalId: string, sessionFile: string): void {
		const sessions = this.read();
		const existing = sessions.findIndex((s) => s.terminalId === terminalId);
		if (existing >= 0) {
			sessions[existing].sessionFile = sessionFile;
		} else {
			sessions.push({ terminalId, sessionFile });
		}
		void this.write(sessions);
	}

	/** Associate a VS Code terminal object with a terminalId for cleanup. */
	register(terminal: vscode.Terminal, terminalId: string): void {
		this.terminalIds.set(terminal, terminalId);
	}

	/** Called when a terminal closes. Preserves entry on shutdown. */
	onClose(terminal: vscode.Terminal): void {
		if (terminal.name !== "Pi Agent" && !terminal.name.startsWith("Pi Agent"))
			return;
		// Preserve sessions across VS Code shutdown restarts
		if (terminal.exitStatus?.reason === vscode.TerminalExitReason.Shutdown)
			return;
		const id = this.terminalIds.get(terminal);
		if (!id) return;
		const sessions = this.read().filter((s) => s.terminalId !== id);
		void this.write(sessions);
	}

	/** Restore valid sessions on activation. Invalid/missing files are pruned. */
	async restore(bridge: Bridge, extensionUri: vscode.Uri): Promise<void> {
		const sessions = this.read();
		const valid: SessionEntry[] = [];

		for (const entry of sessions) {
			if (!fs.existsSync(entry.sessionFile)) continue; // prune stale
			valid.push(entry);
			const terminal = await createPiTerminal(bridge, extensionUri, {
				sessionFile: entry.sessionFile,
				extraArgs: [],
			});
			if (terminal) {
				this.terminalIds.set(terminal, entry.terminalId);
				// Brief title hint that this was restored
				void vscode.window.showInformationMessage(
					`Pi: restored session from ${entry.sessionFile.split("/").pop() ?? entry.sessionFile}`,
				);
			}
		}

		if (valid.length !== sessions.length) {
			void this.write(valid); // persist pruned list
		}
	}

	/** All currently tracked session entries. */
	getSessions(): SessionEntry[] {
		return this.read();
	}

	private read(): SessionEntry[] {
		return this.context.workspaceState.get<SessionEntry[]>(SESSIONS_KEY, []);
	}

	private async write(sessions: SessionEntry[]): Promise<void> {
		await this.context.workspaceState.update(SESSIONS_KEY, sessions);
	}
}
