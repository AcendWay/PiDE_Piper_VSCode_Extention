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
} from "../terminal";

// ── Model lists ───────────────────────────────────────────────────────────────

const RECENT_MODELS_KEY = "piSidebar.recentModels";
const MAX_RECENT = 5;

/**
 * Read the user's actual enabled models from pi's settings.json.
 * Falls back to a minimal hardcoded list if the file isn't found.
 */
function getPiEnabledModels(): string[] {
	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
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
	return ["claude-sonnet-4.6", "claude-opus-4.7", "gemini-2.5-pro", "gpt-4o"];
}

/**
 * Read the default model pi is currently configured to use.
 */
function getPiDefaultModel(): string {
	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
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
	/** Current list of tabs for the mini-strip. */
	private tabs: import("../agentTabState").AgentTabState[] = [];
	/** terminalId of the currently-active tab. */
	private currentTerminalId: string | null = null;

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

	/** Push updated tab list to the webview mini-strip. */
	notifyTabsChanged(
		tabs: import("../agentTabState").AgentTabState[],
		currentTerminalId: string | null,
	): void {
		this.tabs = tabs;
		this.currentTerminalId = currentTerminalId;
		this.post({ type: "tabsChanged", tabs: tabs.map(serializeTab), currentTerminalId });
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
			case "focusTab": {
				// Delegate to extension which holds the terminalMap
				await vscode.commands.executeCommand("piSidebar.focusTab", msg.terminalId);
				break;
			}
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
			case "newTab":
				await vscode.commands.executeCommand("piSidebar.newTab");
				break;
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
				// Push current tabs
				this.post({
					type: "tabsChanged",
					tabs: this.tabs.map(serializeTab),
					currentTerminalId: this.currentTerminalId,
				});
				break;
			}
		}
	}

	/**
	 * Switch the active Pi session to a different model in-place.
	 * No terminal restart. Queues a pending switch that pi polls every ~2s.
	 * If no terminal is running, just persists the preference.
	 */
	async applyModel(model: string): Promise<void> {
		if (!model) return;
		await addRecentModel(this.context, model);
		// Optimistic dropdown update — confirmed once bridge fires onTabUpdated
		this.notifyModelChanged(model);

		const currentId = this.bridge.state.currentTerminalId;
		if (currentId && this.bridge.state.tabs.has(currentId)) {
			// Live tracked terminal: queue in-place switch, pi picks it up in ~2s
			this.bridge.state.pendingModelSwitches.set(currentId, model);
			vscode.window.setStatusBarMessage(
				`$(sync~spin) Switching Pi to ${model}…`,
				4000,
			);
		} else if (findPiTerminal()) {
			// Terminal exists but isn’t yet tracked (e.g. pre-activation terminal)
			// Fall back to text injection
			const t = findPiTerminal();
			if (t) t.sendText(`/model ${model}`, true);
			const cfg = vscode.workspace.getConfiguration("piSidebar");
			await cfg.update("defaultModel", model, vscode.ConfigurationTarget.Global);
			vscode.window.setStatusBarMessage(
				`$(check) Pi model set to ${model}`,
				4000,
			);
		} else {
			// No terminal — persist preference only, do not spawn
			const cfg = vscode.workspace.getConfiguration("piSidebar");
			await cfg.update("defaultModel", model, vscode.ConfigurationTarget.Global);
			vscode.window.setStatusBarMessage(
				`$(check) Pi will use ${model} on next start`,
				4000,
			);
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

	private html(_webview: vscode.Webview): string {
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
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100vh;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
}
.status-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  background: var(--vscode-testing-iconFailed, #f44747);
  flex-shrink: 0;
  transition: background 0.3s, box-shadow 0.3s;
  box-shadow: 0 0 0 0 rgba(137, 209, 133, 0);
}
.status-dot.running {
  background: var(--vscode-testing-iconPassed, #89d185);
  box-shadow: 0 0 0 3px rgba(137, 209, 133, 0.18);
}
.header-title {
  flex: 1;
  font-weight: 600;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.01em;
}
.workspace-name {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

/* ── Mini tab strip ── */
.tab-strip { display: flex; flex-direction: column; gap: 3px; }
.tab-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  font-family: inherit;
  text-align: left;
  width: 100%;
  transition: background 0.12s;
}
.tab-row:hover { background: var(--vscode-list-hoverBackground); }
.tab-row.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  border-left: 2px solid var(--vscode-focusBorder, #007acc);
  padding-left: 4px;
}
.tab-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: transparent;
  border: 1.5px solid var(--vscode-descriptionForeground);
}
.tab-dot.clear  { background: transparent; border-color: var(--vscode-descriptionForeground); }
.tab-dot.idle   { background: #e5a731; border-color: #e5a731; }
.tab-dot.working {
  background: var(--vscode-testing-iconPassed, #89d185);
  border-color: var(--vscode-testing-iconPassed, #89d185);
  box-shadow: 0 0 0 2px rgba(137,209,133,0.25);
}
.tab-dot.attention { background: var(--vscode-testing-iconFailed, #f44747); border-color: var(--vscode-testing-iconFailed, #f44747); }
.tab-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.tab-model { font-size: 9px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.tab-strip-empty { font-size: 10px; color: var(--vscode-descriptionForeground); font-style: italic; padding: 2px 6px; }

/* ── Sections ── */
.section { display: flex; flex-direction: column; gap: 6px; }
.section-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--vscode-descriptionForeground);
  font-weight: 700;
}

/* ── Model selector ── */
.model-row { display: flex; gap: 6px; align-items: center; }
select {
  flex: 1;
  min-width: 0;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s;
}
select:focus { border-color: var(--vscode-focusBorder); }
.view-all-btn {
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 4px;
  white-space: nowrap;
  font-family: inherit;
  border-radius: 3px;
  transition: background 0.15s;
}
.view-all-btn:hover { background: var(--vscode-toolbar-hoverBackground); text-decoration: underline; }

/* ── Context window ── */
.ctx-bar-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ctx-bar-track {
  height: 6px;
  background: var(--vscode-progressBar-background, rgba(128,128,128,0.2));
  border-radius: 4px;
  overflow: hidden;
}
.ctx-bar-fill {
  height: 100%;
  border-radius: 4px;
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
  gap: 5px;
  min-height: 20px;
  flex-wrap: wrap;
  padding: 4px 6px;
  background: var(--vscode-input-background);
  border-radius: 4px;
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
  padding: 1px 5px;
  border-radius: 3px;
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
  gap: 6px;
}
button.action {
  padding: 6px 5px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.15s, opacity 0.15s;
}
button.action:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button.action.primary {
  grid-column: span 2;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 12px;
  padding: 7px;
  font-weight: 600;
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

<!-- Mini tab strip -->
<div class="section" id="tabStripSection">
  <div class="section-label">Active Sessions</div>
  <div class="tab-strip" id="tabStrip">
    <span class="tab-strip-empty">No Pi terminals running</span>
  </div>
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

<!-- Quick actions -->
<div class="section">
  <div class="actions">
    <button class="action primary" id="openBtn"
      data-action="open">
      ${this.terminalRunning ? "▶ Focus Terminal" : "▶ Open Terminal"}
    </button>
    <button class="action" id="ctxBtn" data-action="sendContext"
      ${this.terminalRunning ? "" : "disabled"}>📎 Send Context</button>
    <button class="action" id="diffBtn" data-action="reviewDiffs"
      ${this.terminalRunning ? "" : "disabled"}>⎇ Review Diffs</button>
    <button class="action" id="newBtn" data-action="newTab"
      title="Open another Pi terminal alongside this one. Optional label distinguishes tabs at a glance.">✦ New Pi Tab</button>
    <button class="action" id="restartBtn" data-action="restart"
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

// Action button delegation — strict CSP (script-src nonce-only) blocks inline onclick.
document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;
  if (action) send(action);
});

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

// ── Mini tab strip ───────────────────────────────────────────────
function renderTabStrip(tabs, currentId) {
  const strip = document.getElementById('tabStrip');
  if (!strip) return;
  if (!tabs || !tabs.length) {
    strip.innerHTML = '<span class="tab-strip-empty">No Pi terminals running</span>';
    return;
  }
  strip.innerHTML = tabs.map(tab => {
    const isActive = tab.terminalId === currentId;
    const dotClass = tab.agentState || 'clear';
    const model = tab.model ? '<span class="tab-model">' + esc(tab.model) + '</span>' : '';
    return '<button class="tab-row' + (isActive ? ' active' : '') + '" ' +
      'data-tid="' + esc(tab.terminalId) + '">' +
      '<span class="tab-dot ' + dotClass + '"></span>' +
      '<span class="tab-title">' + esc(tab.title) + '</span>' +
      model + '</button>';
  }).join('');
}

document.getElementById('tabStrip').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tid]');
  if (!btn) return;
  send('focusTab', { terminalId: btn.dataset.tid });
});

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'terminalState': updateTerminalState(msg.running); break;
    case 'contextUsage':  updateContextBar(msg.used, msg.total, msg.reset); break;
    case 'fileStatus':    updateFileRow(msg.status); break;
    case 'modelChanged':  updateModel(msg.model); break;
    case 'tabsChanged':   renderTabStrip(msg.tabs, msg.currentTerminalId); break;
  }
});



send('ready');
</script>
</body>
</html>`;
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Serialize a tab for the webview (avoid sending internal fields). */
function serializeTab(tab: import("../agentTabState").AgentTabState): object {
	return {
		terminalId: tab.terminalId,
		title: tab.title,
		agentState: tab.agentState,
		model: tab.model,
		index: tab.index,
	};
}

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
	terminalId?: string;
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
