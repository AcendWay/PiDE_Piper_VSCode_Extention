import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { findPiBinary } from "../pi";

// ── Model data ────────────────────────────────────────────────────────────────

interface ModelEntry {
	provider: string;
	id: string;
	context: string;
	maxOut: string;
	thinking: boolean;
	images: boolean;
	custom: boolean;
}

function parseListModelsOutput(raw: string): ModelEntry[] {
	const lines = raw.split("\n").filter((l) => l.trim());
	const entries: ModelEntry[] = [];
	for (const line of lines) {
		// Skip header
		if (line.startsWith("provider")) continue;
		const cols = line.trim().split(/\s+/);
		if (cols.length < 6) continue;
		entries.push({
			provider: cols[0],
			id: cols[1],
			context: cols[2],
			maxOut: cols[3],
			thinking: cols[4] === "yes",
			images: cols[5] === "yes",
			custom: false,
		});
	}
	return entries;
}

function loadCustomModelIds(): string[] {
	const p = path.join(os.homedir(), ".pi", "agent", "models.json");
	try {
		const data = JSON.parse(fs.readFileSync(p, "utf8"));
		const ids: string[] = [];
		for (const prov of Object.values(data.providers ?? {})) {
			for (const m of (prov as any).models ?? []) {
				if (m.id) ids.push(m.id);
			}
		}
		return ids;
	} catch {
		return [];
	}
}

function fetchModels(): ModelEntry[] {
	try {
		const piPath = findPiBinary();
		const raw = child_process.execSync(`"${piPath}" --list-models`, {
			encoding: "utf8",
			timeout: 10_000,
		});
		const entries = parseListModelsOutput(raw);
		const customIds = new Set(loadCustomModelIds());
		for (const e of entries) {
			if (customIds.has(e.id)) e.custom = true;
		}
		return entries;
	} catch {
		return [];
	}
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ModelsViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.models";

	private view?: vscode.WebviewView;
	private models: ModelEntry[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onSelectModel: (model: string) => Promise<void>,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html(view.webview);

		view.webview.onDidReceiveMessage(
			async (msg: { type: string; model?: string }) => {
				switch (msg.type) {
					case "refresh":
						this.refresh();
						break;
					case "selectModel":
						if (msg.model) await this.onSelectModel(msg.model);
						break;
					case "editModelsJson": {
						const p = path.join(os.homedir(), ".pi", "agent", "models.json");
						if (!fs.existsSync(p)) {
							fs.mkdirSync(path.dirname(p), { recursive: true });
							fs.writeFileSync(
								p,
								JSON.stringify(
									{
										providers: {
											ollama: {
												baseUrl: "http://localhost:11434/v1",
												api: "openai-completions",
												apiKey: "ollama",
												compat: {
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
												models: [{ id: "llama3.1:8b" }],
											},
										},
									},
									null,
									2,
								),
							);
						}
						await vscode.commands.executeCommand(
							"vscode.open",
							vscode.Uri.file(p),
						);
						break;
					}
				}
			},
		);

		view.onDidChangeVisibility(() => {
			if (view.visible) this.refresh();
		});

		this.refresh();
	}

	/** Push latest model + current selection to webview. */
	notifyCurrentModel(model: string): void {
		this.post({ type: "currentModel", model });
	}

	private refresh(): void {
		this.models = fetchModels();
		const cfg = vscode.workspace.getConfiguration("piSidebar");
		const current = cfg.get<string>("defaultModel", "") ?? "";
		this.post({ type: "models", models: this.models, current });
	}

	private post(message: unknown): void {
		void this.view?.webview.postMessage(message);
	}

	// ── HTML ─────────────────────────────────────────────────────────────────

	private html(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString("hex");
		void webview;
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
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
}
.toolbar {
  display: flex; gap: 5px; padding: 8px; flex-shrink: 0;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
  align-items: center;
}
input.search {
  flex: 1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px; padding: 3px 7px; font-size: 11px;
  font-family: inherit; outline: none;
}
input.search:focus { border-color: var(--vscode-focusBorder); }
.icon-btn {
  background: none; border: none;
  color: var(--vscode-foreground);
  cursor: pointer; font-size: 14px; padding: 2px 4px;
  opacity: 0.7; border-radius: 3px; flex-shrink: 0;
}
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

/* Provider groups */
.list { flex: 1; overflow-y: auto; padding-bottom: 8px; }
.provider-header {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.07em; color: var(--vscode-descriptionForeground);
  padding: 10px 10px 4px; position: sticky; top: 0;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  z-index: 1;
}
.model-row {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 10px; cursor: default;
}
.model-row:hover { background: var(--vscode-list-hoverBackground); }
.model-row.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.model-id {
  flex: 1; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.model-row.active .model-id { font-weight: 600; }
.badges { display: flex; gap: 3px; flex-shrink: 0; }
.badge {
  font-size: 9px; padding: 1px 4px; border-radius: 2px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  white-space: nowrap;
}
.badge.thinking { background: #5a3e8a; color: #e8d5ff; }
.badge.images   { background: #1e5a4a; color: #d0f0e8; }
.badge.custom   { background: #5a4a1e; color: #f0e8d0; }
.meta { font-size: 9px; color: var(--vscode-descriptionForeground); flex-shrink: 0; white-space: nowrap; }
.model-row.active .meta { color: inherit; opacity: 0.8; }
.use-btn {
  font-size: 9px; padding: 1px 7px; border-radius: 2px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; cursor: pointer; font-family: inherit; flex-shrink: 0; opacity: 0;
  transition: opacity 0.1s;
}
.model-row:hover .use-btn,
.model-row.active .use-btn { opacity: 1; }
.model-row.active .use-btn {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.use-btn:hover { background: var(--vscode-button-hoverBackground); color: var(--vscode-button-foreground); }

.footer {
  padding: 6px 10px; border-top: 1px solid var(--vscode-widget-border, transparent);
  display: flex; gap: 5px; flex-shrink: 0;
}
.footer-btn {
  flex: 1; font-size: 10px; padding: 4px; border-radius: 3px; border: none;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer; font-family: inherit;
}
.footer-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.status { padding: 20px 16px; text-align: center;
  color: var(--vscode-descriptionForeground); font-size: 12px; }
</style>
</head>
<body>

<div class="toolbar">
  <input class="search" id="search" type="text" placeholder="Search models…" oninput="onSearch()">
  <button class="icon-btn" title="Refresh models" onclick="send('refresh')">↻</button>
</div>

<div class="list" id="list">
  <div class="status">Loading models…</div>
</div>

<div class="footer">
  <button class="footer-btn" onclick="send('editModelsJson')" title="Add custom models via ~/.pi/agent/models.json">
    ✎ Edit models.json
  </button>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let allModels = [];
let currentModel = '';
let query = '';

function send(type, extra) { vscode.postMessage({ type, ...extra }); }

function esc(s) {
  const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML;
}

function onSearch() {
  query = document.getElementById('search').value.toLowerCase();
  render();
}

function render() {
  if (!allModels.length) {
    document.getElementById('list').innerHTML =
      '<div class="status">No models found.<br>Is <code>pi</code> installed?</div>';
    return;
  }

  // Filter
  const filtered = query
    ? allModels.filter(m => (m.provider + ' ' + m.id).toLowerCase().includes(query))
    : allModels;

  if (!filtered.length) {
    document.getElementById('list').innerHTML = '<div class="status">No models match.</div>';
    return;
  }

  // Group by provider
  const groups = {};
  for (const m of filtered) {
    (groups[m.provider] = groups[m.provider] || []).push(m);
  }

  let html = '';
  for (const [provider, models] of Object.entries(groups)) {
    html += '<div class="provider-header">' + esc(provider) + ' (' + models.length + ')</div>';
    for (const m of models) {
      const isActive = m.id === currentModel || (provider + '/' + m.id) === currentModel;
      const cls = 'model-row' + (isActive ? ' active' : '');
      const label = isActive ? '✓ Active' : 'Use';
      const badges = [
        m.thinking ? '<span class="badge thinking">thinking</span>' : '',
        m.images   ? '<span class="badge images">vision</span>'   : '',
        m.custom   ? '<span class="badge custom">custom</span>'   : '',
      ].filter(Boolean).join('');
      html += '<div class="' + cls + '">' +
        '<div class="model-id" title="' + esc(m.id) + '">' + esc(m.id) + '</div>' +
        '<div class="meta">' + esc(m.context) + '</div>' +
        (badges ? '<div class="badges">' + badges + '</div>' : '') +
        '<button class="use-btn" onclick="send('selectModel',{model:'' + esc(m.id) + ''})">' + label + '</button>' +
      '</div>';
    }
  }

  document.getElementById('list').innerHTML = html;
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'models') {
    allModels = msg.models || [];
    currentModel = msg.current || '';
    render();
  }
  if (msg.type === 'currentModel') {
    currentModel = msg.model || '';
    render();
  }
});
</script>
</body>
</html>`;
	}
}
