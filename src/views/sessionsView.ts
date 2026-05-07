import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Bridge } from "../bridge/server";
import type { SessionTracker } from "../sessions";
import { createPiTerminal } from "../terminal";

// ── Session file parsing ──────────────────────────────────────────────────────

interface SessionMeta {
	id: string;
	filePath: string;
	fileName: string;
	createdAt: Date;
	lastActiveAt: Date;
	cwd: string;
	model: string;
	messageCount: number;
	firstUserMessage: string;
	parentId: string | null;
	totalTokens: number;
}

function parseSessionFile(filePath: string): SessionMeta | null {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim());
		if (!lines.length) return null;

		let id = "";
		let cwd = "";
		let createdAt = new Date(0);
		let lastActiveAt = new Date(0);
		let model = "";
		let messageCount = 0;
		let firstUserMessage = "";
		let parentId: string | null = null;
		let totalTokens = 0;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				const ts = entry.timestamp
					? new Date(entry.timestamp as string)
					: new Date(0);
				if (ts > lastActiveAt) lastActiveAt = ts;

				switch (entry.type) {
					case "session":
						id = String(entry.id ?? "");
						cwd = String(entry.cwd ?? "");
						createdAt = ts;
						break;
					case "model_change":
						if (!model) model = String((entry as any).modelId ?? "");
						if (!parentId)
							parentId = String((entry as any).parentId ?? "") || null;
						break;
					case "message": {
						const msg = (entry as any).message as
							| {
									role: string;
									content: unknown[];
							  }
							| undefined;
						if (!msg) break;
						if (msg.role === "user" && !firstUserMessage) {
							const textBlock = (msg.content ?? []).find(
								(c: any) => c?.type === "text",
							) as { text?: string } | undefined;
							const text = textBlock?.text ?? "";
							// Skip system-injected prompts
							if (!text.startsWith("You are running inside VS Code")) {
								firstUserMessage = text.slice(0, 120).replace(/\n/g, " ");
							}
						}
						if (msg.role === "assistant") {
							messageCount++;
							const usage = (entry as any).usage;
							if (usage?.totalTokens) totalTokens += Number(usage.totalTokens);
						}
						break;
					}
				}
			} catch {
				// Skip malformed lines
			}
		}

		if (!id) return null;

		return {
			id,
			filePath,
			fileName: path.basename(filePath),
			createdAt,
			lastActiveAt,
			cwd,
			model: model || "unknown",
			messageCount,
			firstUserMessage: firstUserMessage || "(no messages yet)",
			parentId,
			totalTokens,
		};
	} catch {
		return null;
	}
}

function getPiSessionsDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions");
}

function getAllSessionFiles(): string[] {
	const baseDir = getPiSessionsDir();
	if (!fs.existsSync(baseDir)) return [];
	const files: string[] = [];
	try {
		for (const subdir of fs.readdirSync(baseDir)) {
			const subdirPath = path.join(baseDir, subdir);
			if (!fs.statSync(subdirPath).isDirectory()) continue;
			for (const file of fs.readdirSync(subdirPath)) {
				if (file.endsWith(".jsonl")) {
					files.push(path.join(subdirPath, file));
				}
			}
		}
	} catch {
		// ignore
	}
	return files.sort((a, b) => b.localeCompare(a)); // newest first by filename timestamp
}

function _dateGroup(d: Date): string {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 86400_000);
	const weekAgo = new Date(today.getTime() - 7 * 86400_000);
	if (d >= today) return "Today";
	if (d >= yesterday) return "Yesterday";
	if (d >= weekAgo) return "This Week";
	return "Older";
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class SessionsViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.sessions";

	private view?: vscode.WebviewView;
	private sessions: SessionMeta[] = [];
	private activeSessions = new Set<string>(); // active session file paths

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly bridge?: Bridge,
		private readonly sessionTracker?: SessionTracker,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		this.refresh();
		view.webview.html = this.html(view.webview);

		view.webview.onDidReceiveMessage(
			async (msg: { type: string; filePath?: string }) => {
				switch (msg.type) {
					case "refresh":
						this.refresh();
						break;
					case "resume":
						if (msg.filePath && this.bridge) await this.resume(msg.filePath);
						break;
					case "fork":
						if (msg.filePath && this.bridge) await this.fork(msg.filePath);
						break;
				}
			},
		);

		view.onDidChangeVisibility(() => {
			if (view.visible) this.refresh();
		});
	}

	/** Called by extension when active terminal sessions change. */
	setActiveSessions(filePaths: string[]): void {
		this.activeSessions = new Set(filePaths);
		this.pushSessions();
	}

	private refresh(): void {
		const files = getAllSessionFiles();
		this.sessions = files
			.map(parseSessionFile)
			.filter((s): s is SessionMeta => s !== null)
			.slice(0, 200);
		this.pushSessions();
	}

	private pushSessions(): void {
		void this.view?.webview.postMessage({
			type: "sessions",
			sessions: this.sessions,
			active: [...this.activeSessions],
		});
	}

	private async resume(filePath: string): Promise<void> {
		if (!this.bridge) return;
		const res = await createPiTerminal(
			this.bridge,
			this.context.extensionUri,
			{
				sessionFile: filePath,
			},
		);
		res?.terminal.show();
	}

	private async fork(filePath: string): Promise<void> {
		if (!this.bridge) return;
		// Copy the session file with a new timestamp prefix
		const dir = path.dirname(filePath);
		const now = new Date().toISOString().replace(/[:.]/g, "-");
		const newName = `${now}_fork_${path.basename(filePath)}`;
		const dest = path.join(dir, newName);
		try {
			fs.copyFileSync(filePath, dest);
		} catch (e) {
			vscode.window.showErrorMessage(`Pi: Could not fork session: ${e}`);
			return;
		}
		const forkRes = await createPiTerminal(
			this.bridge,
			this.context.extensionUri,
			{
				sessionFile: dest,
			},
		);
		forkRes?.terminal.show();
	}

	private html(_webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString("hex");
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
  flex-shrink: 0;
}
.search {
  flex: 1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  padding: 3px 7px;
  font-size: 11px;
  font-family: inherit;
  outline: none;
}
.search:focus { border-color: var(--vscode-focusBorder); }
.refresh-btn {
  background: none;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
  opacity: 0.7;
  border-radius: 3px;
}
.refresh-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.list { flex: 1; overflow-y: auto; padding: 4px 0; }
.group-header {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--vscode-descriptionForeground);
  padding: 10px 10px 4px;
}
.session {
  padding: 6px 10px;
  cursor: default;
  border-left: 2px solid transparent;
}
.session:hover { background: var(--vscode-list-hoverBackground); }
.session.child { padding-left: 24px; border-left-color: var(--vscode-widget-border, transparent); margin-left: 10px; }
.session-header {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}
.status-dot { font-size: 10px; flex-shrink: 0; }
.session-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-actions { display: flex; gap: 3px; flex-shrink: 0; opacity: 0; transition: opacity 0.1s; }
.session:hover .session-actions { opacity: 1; }
.btn {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  cursor: pointer;
  font-family: inherit;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.session-meta {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.session-preview {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
  padding: 4px 6px;
  background: var(--vscode-input-background);
  border-radius: 3px;
  border-left: 2px solid var(--vscode-focusBorder, #007acc);
  white-space: pre-wrap;
  word-break: break-word;
  display: none;
}
.session.expanded .session-preview { display: block; }
.empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
</style>
</head>
<body>
<div class="toolbar">
  <input class="search" id="search" type="text" placeholder="Filter sessions…">
  <button class="refresh-btn" id="refreshBtn" title="Refresh sessions">↻</button>
</div>
<div class="list" id="list">
  <div class="empty">Loading sessions…</div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let allSessions = [];
let activePaths = new Set();
let query = '';

function send(type, extra) { vscode.postMessage({ type, ...extra }); }

function filter() {
  query = document.getElementById('search').value.toLowerCase();
  render();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function timeSince(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function dateGroup(isoStr) {
  const d = new Date(isoStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today - 86400000);
  const weekAgo = new Date(today - 7 * 86400000);
  if (d >= today) return 'Today';
  if (d >= yesterday) return 'Yesterday';
  if (d >= weekAgo) return 'This Week';
  return 'Older';
}

function statusDot(filePath) {
  if (activePaths.has(filePath)) return '<span class="status-dot" title="Active">🟢</span>';
  return '<span class="status-dot" title="Closed">⚪</span>';
}

function sessionCard(s, isChild) {
  const cls = 'session' + (isChild ? ' child' : '');
  const title = s.firstUserMessage && s.firstUserMessage !== '(no messages yet)'
    ? s.firstUserMessage : s.fileName;
  const kwMatch = !query ||
    title.toLowerCase().includes(query) ||
    (s.model || '').toLowerCase().includes(query) ||
    (s.cwd || '').toLowerCase().includes(query);
  if (!kwMatch) return '';
  const meta = [
    s.model !== 'unknown' ? s.model : '',
    s.messageCount + ' msg' + (s.messageCount !== 1 ? 's' : ''),
    timeSince(s.lastActiveAt),
    s.totalTokens > 0 ? Math.round(s.totalTokens / 1000) + 'k tok' : ''
  ].filter(Boolean).join(' · ');

  return \`<div class="\${cls}" id="s-\${esc(s.id)}"
    data-id="\${esc(s.id)}" data-file="\${esc(s.filePath)}">
    <div class="session-header" data-action="toggle" data-id="\${esc(s.id)}">
      \${statusDot(s.filePath)}
      <span class="session-title" title="\${esc(title)}">\${esc(title)}</span>
      <span class="session-actions">
        <button class="btn" data-action="resume" data-file="\${esc(s.filePath)}">Resume</button>
        <button class="btn" data-action="fork" data-file="\${esc(s.filePath)}">Fork</button>
      </span>
    </div>
    <div class="session-meta">\${esc(meta)}</div>
    <div class="session-preview">\${esc(s.firstUserMessage)}</div>
  </div>\`;
}

function toggle(id) {
  const el = document.getElementById('s-' + id);
  if (el) el.classList.toggle('expanded');
}

function render() {
  if (!allSessions.length) {
    document.getElementById('list').innerHTML =
      '<div class="empty">No sessions found.<br>Start a Pi terminal to create one.</div>';
    return;
  }

  // Build parent→children map
  const byId = {};
  const children = {};
  for (const s of allSessions) {
    byId[s.id] = s;
    if (s.parentId) {
      (children[s.parentId] = children[s.parentId] || []).push(s);
    }
  }

  // Group root sessions by date
  const groups = {};
  for (const s of allSessions) {
    if (s.parentId && byId[s.parentId]) continue; // skip children
    const g = dateGroup(s.createdAt);
    (groups[g] = groups[g] || []).push(s);
  }

  const order = ['Today','Yesterday','This Week','Older'];
  let html = '';
  for (const group of order) {
    const items = groups[group];
    if (!items?.length) continue;
    let groupHtml = '';
    for (const s of items) {
      const card = sessionCard(s, false);
      if (!card) continue;
      groupHtml += card;
      // Render children (forks)
      for (const child of (children[s.id] || [])) {
        groupHtml += sessionCard(child, true);
      }
    }
    if (groupHtml) {
      html += '<div class="group-header">' + group + '</div>' + groupHtml;
    }
  }

  document.getElementById('list').innerHTML = html ||
    '<div class="empty">No sessions match the filter.</div>';
}

// Event delegation — strict CSP (script-src nonce-only) blocks inline onclick.
document.getElementById('search').addEventListener('input', () => filter());
document.getElementById('refreshBtn').addEventListener('click', () => send('refresh'));

document.body.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'toggle') {
    if (el.dataset.id) toggle(el.dataset.id);
  } else if (action === 'resume' || action === 'fork') {
    e.stopPropagation();
    if (el.dataset.file) send(action, { filePath: el.dataset.file });
  }
});

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'sessions') {
    allSessions = msg.sessions || [];
    activePaths = new Set(msg.active || []);
    render();
  }
});

// Ask host for current session list now that listeners are attached.
send('refresh');
</script>
</body>
</html>`;
	}
}
