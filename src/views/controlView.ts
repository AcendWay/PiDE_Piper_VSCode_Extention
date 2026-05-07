import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Bridge } from "../bridge/server";
import {
	createPiTerminal,
	findPiTerminal,
	focusOrCreateTerminal,
	restartPiTerminal,
} from "../terminal";

// ── Model lists ───────────────────────────────────────────────────────────────

const RECENT_MODELS_KEY = "piSidebar.recentModels";
const MAX_RECENT = 5;

/**
 * Read the user's actual enabled models from pi's settings.json.
 * Falls back to a minimal hardcoded list if the file isn't found.
 */
function getPiEnabledModels(): string[] {
	const settingsPath = path.join(
		os.homedir(),
		".pi",
		"agent",
		"settings.json",
	);
	try {
		const raw = fs.readFileSync(settingsPath, "utf8");
		const settings = JSON.parse(raw) as {
			enabledModels?: string[];
			defaultModel?: string;
			defaultProvider?: string;
		};
		const enabled = settings.enabledModels ?? [];
		if (enabled.length > 0) return enabled;
	} catch {
		// settings.json missing or malformed — fall through to defaults
	}
	// Minimal fallback when pi isn't configured yet
	return [
		"claude-sonnet-4.6",
		"claude-opus-4.7",
		"gemini-2.5-pro",
		"gpt-4o",
	];
}

/**
 * Read the default model pi is currently configured to use.
 */
function getPiDefaultModel(): string {
	const settingsPath = path.join(
		os.homedir(),
		".pi",
		"agent",
		"settings.json",
	);
	try {
		const raw = fs.readFileSync(settingsPath, "utf8");
		const settings = JSON.parse(raw) as { defaultModel?: string };
		return settings.defaultModel ?? "";
	} catch {
		return "";
	}
}

function getRecentModels(context: vscode.ExtensionContext): string[] {
	return context.globalState.get<string[]>(RECENT_MODELS_KEY, []);
}

async function addRecentModel(
	context: vscode.ExtensionContext,
	model: string,
): Promise<void> {
	const recent = getRecentModels(context).filter((m) => m !== model);
	recent.unshift(model);
	await context.globalState.update(
		RECENT_MODELS_KEY,
		recent.slice(0, MAX_RECENT),
	);
}

function buildModelList(
	context: vscode.ExtensionContext,
	current: string,
): { value: string; label: string; group: string }[] {
	const recent = getRecentModels(context);
	const piModels = getPiEnabledModels();
	const seen = new Set<string>();
	const items: { value: string; label: string; group: string }[] = [];

	const add = (value: string, group: string) => {
		if (seen.has(value)) return;
		seen.add(value);
		items.push({ value, label: value, group });
	};

	if (current) add(current, "current");
	for (const m of recent) add(m, "recent");
	for (const m of piModels) add(m, "pi-config");

	return items;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ControlViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.control";

	private view?: vscode.WebviewView;
	private terminalRunning = false;
	private contextPollTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly bridge: Bridge,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		this.terminalRunning = !!findPiTerminal();
		view.webview.html = this.html(view.webview);

		view.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
			await this.handleMessage(msg);
		});

		// Start polling context usage from bridge state
		this.startContextPoll();

		// Stop polling when view is hidden, resume when visible
		view.onDidChangeVisibility(() => {
			if (view.visible) this.startContextPoll();
			else this.stopContextPoll();
		});
	}

	// ── External update hooks ────────────────────────────────────────────────

	notifyTerminalState(running: boolean): void {
		this.terminalRunning = running;
		this.post({ type: "terminalState", running });
		if (!running) {
			// Reset context usage when terminal closes
			this.post({ type: "contextUsage", used: 0, total: 0, reset: true });
		}
	}

	notifyFileStatus(status: FileStatus | null): void {
		this.post({ type: "fileStatus", status });
	}

	notifyModelChanged(model: string): void {
		this.post({ type: "modelChanged", model });
	}

	// ── Context usage polling ────────────────────────────────────────────────

	private startContextPoll(): void {
		if (this.contextPollTimer) return;
		this.contextPollTimer = setInterval(() => {
			const usage = this.bridge.state.contextUsage;
			if (usage) {
				this.post({
					type: "contextUsage",
					used: usage.used,
					total: usage.total,
				});
			}
		}, 3_000);
	}

	private stopContextPoll(): void {
		if (this.contextPollTimer) {
			clearInterval(this.contextPollTimer);
			this.contextPollTimer = undefined;
		}
	}

	dispose(): void {
		this.stopContextPoll();
	}

	// ── Message handler ──────────────────────────────────────────────────────

	private async handleMessage(msg: WebviewMessage): Promise<void> {
		switch (msg.type) {
			case "selectModel":
				await this.applyModel(msg.model ?? "");
				break;
			case "open":
				await focusOrCreateTerminal(this.bridge, this.context.extensionUri);
				this.notifyTerminalState(true);
				break;
			case "restart":
				await vscode.commands.executeCommand("piSidebar.restart");
				break;
			case "sendContext":
				await vscode.commands.executeCommand("piSidebar.sendSelection");
				break;
			case "reviewDiffs":
				await vscode.commands.executeCommand("piSidebar.reviewDiffs");
				break;
			case "newSession":
				await createPiTerminal(this.bridge, this.context.extensionUri);
				this.notifyTerminalState(true);
				break;
			case "dropFile": {
				const { filePath, isImage } = msg;
				if (!filePath) break;
				const terminal = findPiTerminal();
				if (!terminal) break;
				if (isImage) {
					terminal.sendText(`[Image attached: ${filePath}]`, true);
				} else {
					terminal.sendText(`[File context: ${filePath}]`, true);
				}
				break;
			}
			case "ready": {
				// Webview reloaded — push current state
				this.post({ type: "terminalState", running: this.terminalRunning });
				const usage = this.bridge.state.contextUsage;
				if (usage)
					this.post({
						type: "contextUsage",
						used: usage.used,
						total: usage.total,
					});
				break;
			}
		}
	}

	/** Persist model, update command palette, restart terminal. */
	async applyModel(model: string): Promise<void> {
		if (!model) return;
		const cfg = vscode.workspace.getConfiguration("piSidebar");
		await cfg.update("defaultModel", model, vscode.ConfigurationTarget.Global);
		await addRecentModel(this.context, model);
		this.notifyModelChanged(model);

		if (findPiTerminal()) {
			await restartPiTerminal(this.bridge, this.context.extensionUri);
			this.notifyTerminalState(true);
		}
	}

	/** Build the model list for the Quick Pick command (called from extension). */
	buildQuickPickModels(): string[] {
		const cfg = vscode.workspace.getConfiguration("piSidebar");
		const current = cfg.get<string>("defaultModel", "");
		return buildModelList(this.context, current).map((m) => m.value);
	}

	private post(message: unknown): void {
		void this.view?.webview.postMessage(message);
	}

	// ── HTML ─────────────────────────────────────────────────────────────────

	private html(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString("hex");
		const cfg = vscode.workspace.getConfiguration("piSidebar");
		// Prefer VS Code setting override, then fall back to pi's own default
		const currentModel =
			cfg.get<string>("defaultModel", "") || getPiDefaultModel();
		const workspace =
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "No workspace";
		const workspaceName =
			vscode.workspace.workspaceFolders?.[0]?.name ?? "No workspace";

		const models = buildModelList(this.context, currentModel);
		const topModels = models.slice(0, 5);
		const moreModels = models.slice(5);

		const optionHtml = (m: { value: string; label: string }) =>
			`<option value="${esc(m.value)}"${m.value === currentModel ? " selected" : ""}>${esc(m.label)}</option>`;

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: vscode-file:;">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 100vh;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
}
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--vscode-testing-iconFailed, #f44747);
  flex-shrink: 0;
  transition: background 0.3s;
}
.status-dot.running { background: var(--vscode-testing-iconPassed, #89d185); }
.header-title {
  flex: 1;
  font-weight: 600;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-name {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

/* ── Sections ── */
.section { display: flex; flex-direction: column; gap: 5px; }
.section-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vscode-descriptionForeground);
  font-weight: 600;
}

/* ── Model selector ── */
.model-row { display: flex; gap: 5px; align-items: center; }
select {
  flex: 1;
  min-width: 0;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  padding: 4px 6px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
}
select:focus { border-color: var(--vscode-focusBorder); }
.view-all-btn {
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 0;
  white-space: nowrap;
  font-family: inherit;
}
.view-all-btn:hover { text-decoration: underline; }

/* ── Context window ── */
.ctx-bar-wrap {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ctx-bar-track {
  height: 6px;
  background: var(--vscode-progressBar-background, rgba(128,128,128,0.2));
  border-radius: 3px;
  overflow: hidden;
}
.ctx-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--vscode-testing-iconPassed, #89d185);
  transition: width 0.4s ease, background 0.4s ease;
  width: 0%;
}
.ctx-bar-fill.amber { background: #e5a731; }
.ctx-bar-fill.red   { background: var(--vscode-testing-iconFailed, #f44747); }
.ctx-label {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  display: flex;
  justify-content: space-between;
}
.ctx-label.hidden { display: none; }

/* ── File status ── */
.file-row {
  font-size: 11px;
  color: var(--vscode-foreground);
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 20px;
  flex-wrap: wrap;
}
.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-foreground);
  font-size: 11px;
}
.file-none { color: var(--vscode-descriptionForeground); font-style: italic; }
.badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 2px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  flex-shrink: 0;
}
.cursor { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.dirty { color: var(--vscode-gitDecoration-modifiedResourceForeground, #89d185); flex-shrink: 0; }
.errors { color: var(--vscode-testing-iconFailed, #f44747); font-size: 10px; flex-shrink: 0; }
.warns  { color: #e5a731; font-size: 10px; flex-shrink: 0; }

/* ── Quick actions ── */
.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
button.action {
  padding: 5px 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
button.action:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button.action.primary {
  grid-column: span 2;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 12px;
  padding: 6px;
}
button.action.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.action:disabled { opacity: 0.38; cursor: default; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="status-dot${this.terminalRunning ? " running" : ""}" id="dot"></div>
  <span class="header-title" id="statusText">
    ${this.terminalRunning ? "Pi Agent running" : "Pi Agent stopped"}
  </span>
  <span class="workspace-name" title="${esc(workspace)}">${esc(workspaceName)}</span>
</div>

<!-- Model selector -->
<div class="section">
  <div class="section-label">Model</div>
  <div class="model-row">
    <select id="modelSelect" title="Select model">
      <optgroup label="Selected" id="topGroup">
        ${topModels.map(optionHtml).join("\n        ")}
      </optgroup>
      <optgroup label="More models" id="moreGroup" style="display:none">
        ${moreModels.map(optionHtml).join("\n        ")}
      </optgroup>
    </select>
    <button class="view-all-btn" id="viewAllBtn" title="Show all models">▾ more</button>
  </div>
</div>

<!-- Context window indicator -->
<div class="section">
  <div class="section-label">Context Window</div>
  <div class="ctx-bar-wrap">
    <div class="ctx-bar-track">
      <div class="ctx-bar-fill" id="ctxFill"></div>
    </div>
    <div class="ctx-label hidden" id="ctxLabel">
      <span id="ctxUsed">—</span>
      <span id="ctxPct">—</span>
    </div>
  </div>
</div>

<!-- Active file status -->
<div class="section">
  <div class="section-label">Active File</div>
  <div class="file-row" id="fileRow">
    <span class="file-none">No active editor</span>
  </div>
</div>

<!-- Drop zone -->
<div class="section">
  <div class="section-label">Drop Files</div>
  <div class="drop-zone" id="dropZone">
    <img class="drop-thumb" id="dropThumb" alt="preview">
    <div id="dropLabel">🖼 Drop image for vision &nbsp;·&nbsp; 📄 Drop file for context</div>
  </div>
</div>

<!-- Quick actions -->
<div class="section">
  <div class="actions">
    <button class="action primary" id="openBtn"
      onclick="send('${this.terminalRunning ? "open" : "open"}')">
      ${this.terminalRunning ? "▶ Focus Terminal" : "▶ Open Terminal"}
    </button>
    <button class="action" id="ctxBtn" onclick="send('sendContext')"
      ${this.terminalRunning ? "" : "disabled"}>📎 Send Context</button>
    <button class="action" id="diffBtn" onclick="send('reviewDiffs')"
      ${this.terminalRunning ? "" : "disabled"}>⎇ Review Diffs</button>
    <button class="action" id="newBtn" onclick="send('newSession')">✦ New Session</button>
    <button class="action" id="restartBtn" onclick="send('restart')"
      ${this.terminalRunning ? "" : "disabled"}>↺ Restart</button>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let allModelsVisible = false;
let isRunning = ${this.terminalRunning};

function send(type, extra) {
  vscode.postMessage({ type, ...extra });
}

// Model selector
const modelSelect = document.getElementById('modelSelect');
const moreGroup = document.getElementById('moreGroup');
const viewAllBtn = document.getElementById('viewAllBtn');

modelSelect.addEventListener('change', () => {
  const model = modelSelect.value;
  if (!model) return;
  send('selectModel', { model });
});

viewAllBtn.addEventListener('click', () => {
  allModelsVisible = !allModelsVisible;
  moreGroup.style.display = allModelsVisible ? '' : 'none';
  viewAllBtn.textContent = allModelsVisible ? '▴ less' : '▾ more';
});

// Context bar
function updateContextBar(used, total, reset) {
  const fill = document.getElementById('ctxFill');
  const label = document.getElementById('ctxLabel');
  const usedEl = document.getElementById('ctxUsed');
  const pctEl = document.getElementById('ctxPct');

  if (reset || !total) {
    fill.style.width = '0%';
    fill.className = 'ctx-bar-fill';
    label.className = 'ctx-label hidden';
    return;
  }

  const pct = Math.min(100, Math.round((used / total) * 100));
  fill.style.width = pct + '%';
  fill.className = 'ctx-bar-fill' + (pct >= 90 ? ' red' : pct >= 75 ? ' amber' : '');
  label.className = 'ctx-label';
  const usedK = (used / 1000).toFixed(1);
  const totalK = (total / 1000).toFixed(0);
  usedEl.textContent = usedK + 'k / ' + totalK + 'k';
  pctEl.textContent = pct + '%';
}

// File status row
function updateFileRow(status) {
  const row = document.getElementById('fileRow');
  if (!status) {
    row.innerHTML = '<span class="file-none">No active editor</span>';
    return;
  }
  const dirty = status.isDirty ? '<span class="dirty" title="Unsaved changes">●</span>' : '';
  const errors = status.errors > 0 ? '<span class="errors">✗' + status.errors + '</span>' : '';
  const warns  = status.warnings > 0 ? '<span class="warns">⚠' + status.warnings + '</span>' : '';
  const cursor = status.cursor ? '<span class="cursor">:' + status.cursor + '</span>' : '';
  row.innerHTML =
    '<span class="file-path" title="' + esc(status.filePath || '') + '">' + esc(status.filePath || '') + '</span>' +
    '<span class="badge">' + esc(status.languageId || '') + '</span>' +
    cursor + dirty + errors + warns;
}

// Terminal state
function updateTerminalState(running) {
  isRunning = running;
  const dot = document.getElementById('dot');
  const statusText = document.getElementById('statusText');
  const openBtn = document.getElementById('openBtn');
  dot.className = 'status-dot' + (running ? ' running' : '');
  statusText.textContent = running ? 'Pi Agent running' : 'Pi Agent stopped';
  openBtn.textContent = running ? '▶ Focus Terminal' : '▶ Open Terminal';
  ['ctxBtn','diffBtn','restartBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !running;
  });
}

// Model changed externally
function updateModel(model) {
  const opt = modelSelect.querySelector('option[value="' + model + '"]');
  if (opt) {
    modelSelect.value = model;
  } else {
    // Add to top group
    const topGroup = document.getElementById('topGroup');
    const newOpt = document.createElement('option');
    newOpt.value = model;
    newOpt.textContent = model;
    newOpt.selected = true;
    topGroup.prepend(newOpt);
    modelSelect.value = model;
  }
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'terminalState': updateTerminalState(msg.running); break;
    case 'contextUsage':  updateContextBar(msg.used, msg.total, msg.reset); break;
    case 'fileStatus':    updateFileRow(msg.status); break;
    case 'modelChanged':  updateModel(msg.model); break;
  }
});

// Drop zone
const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp']);
const dropZone = document.getElementById('dropZone');
const dropThumb = document.getElementById('dropThumb');
const dropLabel = document.getElementById('dropLabel');

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('over');
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;

  if (!isRunning) {
    setDropState('error', '⚠ No Pi terminal running');
    return;
  }

  for (const file of files) {
    const isImage = IMAGE_EXTS.has(extOf(file.name));
    // In VS Code's Electron environment, File objects have a .path property
    const filePath = (file).path || file.name;

    if (isImage) {
      // Show thumbnail preview briefly
      const reader = new FileReader();
      reader.onload = ev => {
        dropThumb.src = ev.target?.result;
        dropThumb.classList.add('visible');
        dropLabel.style.display = 'none';
        setTimeout(() => {
          dropThumb.classList.remove('visible');
          dropThumb.src = '';
          dropLabel.style.display = '';
          setDropState('', '🖼 Drop image for vision · 📄 Drop file for context');
        }, 1500);
      };
      reader.readAsDataURL(file);
      send('dropFile', { filePath, isImage: true });
      setDropState('success', '✓ Image attached');
    } else {
      send('dropFile', { filePath, isImage: false });
      setDropState('success', '✓ File path sent: ' + file.name);
      setTimeout(() => setDropState('', '🖼 Drop image for vision · 📄 Drop file for context'), 1500);
    }
  }
});

function setDropState(state, text) {
  dropZone.className = 'drop-zone' + (state ? ' ' + state : '');
  dropLabel.textContent = text;
}

send('ready');
</script>
</body>
</html>`;
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileStatus {
	filePath: string;
	languageId: string;
	cursor: string; // "line:col"
	isDirty: boolean;
	errors: number;
	warnings: number;
}

interface WebviewMessage {
	type: string;
	model?: string;
	filePath?: string;
	isImage?: boolean;
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
