import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { Bridge } from "../bridge/server";
import { focusOrCreateTerminal, findPiTerminal } from "../terminal";

/**
 * Phase 1 control panel — minimal placeholder.
 * Phase 2 (#7, #8, #9) will expand this with model selector,
 * context indicator, live file status, and drag-and-drop zone.
 */
export class ControlViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.control";

	private view?: vscode.WebviewView;
	private terminalRunning = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly bridge: Bridge,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		this.terminalRunning = !!findPiTerminal();
		view.webview.html = this.html();

		view.webview.onDidReceiveMessage(
			async (msg: { type: string }) => {
				switch (msg.type) {
					case "open":
						await focusOrCreateTerminal(
							this.bridge,
							this.context.extensionUri,
						);
						this.notifyTerminalState(true);
						break;
					case "restart":
						await vscode.commands.executeCommand("piSidebar.restart");
						break;
					case "sendContext":
						await vscode.commands.executeCommand(
							"piSidebar.sendSelection",
						);
						break;
					case "reviewDiffs":
						await vscode.commands.executeCommand(
							"piSidebar.reviewDiffs",
						);
						break;
					case "newSession":
						await vscode.commands.executeCommand(
							"piSidebar.newSession",
						);
						this.notifyTerminalState(true);
						break;
				}
			},
		);
	}

	/** Called by extension when terminal opens or closes. */
	notifyTerminalState(running: boolean): void {
		this.terminalRunning = running;
		if (this.view) {
			void this.view.webview.postMessage({
				type: "terminalState",
				running,
			});
		}
	}

	private html(): string {
		const nonce = crypto.randomBytes(16).toString("hex");
		const workspace =
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "No workspace";
		const cfg = vscode.workspace.getConfiguration("piSidebar");
		const model = cfg.get<string>("defaultModel", "") || "default model";

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 13px;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--vscode-testing-iconFailed);
    flex-shrink: 0;
  }
  .dot.running { background: var(--vscode-testing-iconPassed); }
  .workspace {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 4px 0;
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  .model-row {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .model-name {
    color: var(--vscode-foreground);
    font-weight: 500;
  }
  .model-change {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    text-decoration: underline;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  button.action {
    padding: 5px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    text-align: center;
  }
  button.action:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button.action.primary {
    grid-column: span 2;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 12px;
    padding: 7px;
  }
  button.action.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button.action:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding-top: 4px;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="dot${this.terminalRunning ? " running" : ""}" id="dot"></div>
    <span id="status">${this.terminalRunning ? "Pi Agent running" : "Pi Agent stopped"}</span>
  </div>

  <div class="workspace" title="${workspace}">📁 ${workspace}</div>

  <div class="model-row">
    Model: <span class="model-name">${model}</span>
    <button class="model-change" onclick="vscode.postMessage({type:'selectModel'})">change</button>
  </div>

  <div class="actions">
    <button class="action primary" id="openBtn"
      onclick="vscode.postMessage({type:'open'})">
      ▶ Open Terminal
    </button>
    <button class="action" id="contextBtn"
      onclick="vscode.postMessage({type:'sendContext'})">
      📎 Send Context
    </button>
    <button class="action" id="diffsBtn"
      onclick="vscode.postMessage({type:'reviewDiffs'})">
      ⎇ Review Diffs
    </button>
    <button class="action" id="newBtn"
      onclick="vscode.postMessage({type:'newSession'})">
      ✦ New Session
    </button>
    <button class="action" id="restartBtn"
      onclick="vscode.postMessage({type:'restart'})">
      ↺ Restart
    </button>
  </div>

  <div class="hint">Context indicator & model selector coming in Phase 2</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let running = ${this.terminalRunning};

  function updateState(r) {
    running = r;
    document.getElementById('dot').className = 'dot' + (r ? ' running' : '');
    document.getElementById('status').textContent = r ? 'Pi Agent running' : 'Pi Agent stopped';
    document.getElementById('openBtn').textContent = r ? '▶ Focus Terminal' : '▶ Open Terminal';
    ['contextBtn','diffsBtn','newBtn','restartBtn'].forEach(id => {
      document.getElementById(id).disabled = !r;
    });
  }

  updateState(running);

  window.addEventListener('message', e => {
    if (e.data.type === 'terminalState') updateState(e.data.running);
  });
</script>
</body>
</html>`;
	}
}
