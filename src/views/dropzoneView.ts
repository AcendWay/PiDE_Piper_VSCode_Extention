import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import * as vscode from "vscode";
import { findPiTerminal } from "../terminal";

export class DropzoneViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.dropzone";

	private view?: vscode.WebviewView;
	private terminalRunning = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		this.terminalRunning = !!findPiTerminal();
		view.webview.html = this.html(view.webview);

		view.webview.onDidReceiveMessage(async (msg: DropWebviewMessage) => {
			await this.handleMessage(msg);
		});
	}

	// ── External update hooks ────────────────────────────────────────────────

	notifyTerminalState(running: boolean): void {
		this.terminalRunning = running;
		this.post({ type: "terminalState", running });
	}

	// ── Message handler ──────────────────────────────────────────────────────

	private async handleMessage(msg: DropWebviewMessage): Promise<void> {
		switch (msg.type) {
			case "sendSelection":
				await vscode.commands.executeCommand("piSidebar.sendSelection");
				break;

			case "dropFile": {
				let { filePath } = msg;
				const { isImage, fileName, fileBase64 } = msg;
				const terminal = findPiTerminal();

				if (!terminal) {
					this.post({
						type: "dropError",
						message: "No Pi terminal running — open Pi Agent first.",
					});
					break;
				}

				// If we got base64 contents but no path (OS file-manager drop in webview
				// — Electron strips File.path), persist to a tmp file and use that.
				if (!filePath && fileBase64 && fileName) {
					try {
						const tmpDir = path.join(os.tmpdir(), "pi-vscode-drops");
						fs.mkdirSync(tmpDir, { recursive: true });
						const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
						const tmpPath = path.join(tmpDir, `${Date.now()}-${safeName}`);
						fs.writeFileSync(tmpPath, Buffer.from(fileBase64, "base64"));
						filePath = tmpPath;
					} catch (err) {
						this.post({
							type: "dropError",
							message: `Failed to stash dropped file: ${(err as Error).message}`,
						});
						break;
					}
				}

				if (!filePath) {
					this.post({
						type: "dropError",
						message: "Dropped item had no readable path or content.",
					});
					break;
				}

				if (isImage) {
					terminal.sendText(`[Image attached: ${filePath}]`, true);
				} else {
					terminal.sendText(`[File context: ${filePath}]`, true);
				}
				break;
			}

			case "ready":
				this.post({ type: "terminalState", running: this.terminalRunning });
				break;
		}
	}

	private post(message: unknown): void {
		void this.view?.webview.postMessage(message);
	}

	// ── HTML ─────────────────────────────────────────────────────────────────

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
html, body {
  height: 100%;
}
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 100%;
}

/* ── Drop zone ── */
.drop-zone {
  flex: 1;
  min-height: 100px;
  border: 1.5px dashed var(--vscode-input-border, rgba(128,128,128,0.45));
  border-radius: 6px;
  padding: 18px 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-input-background);
  transition: all 0.15s ease;
  cursor: copy;
  user-select: none;
}
.drop-zone:hover { border-color: var(--vscode-focusBorder, #007acc); color: var(--vscode-foreground); }
.drop-zone.over {
  border-color: var(--vscode-focusBorder, #007acc);
  background: var(--vscode-list-dropBackground, rgba(0,122,204,0.12));
  color: var(--vscode-foreground);
}
.drop-zone.success { border-color: var(--vscode-testing-iconPassed, #89d185); color: var(--vscode-testing-iconPassed, #89d185); }
.drop-zone.error   { border-color: var(--vscode-testing-iconFailed, #f44747); color: var(--vscode-testing-iconFailed, #f44747); }
.drop-zone.no-terminal { cursor: not-allowed; opacity: 0.55; }

.drop-label { font-size: 12px; font-weight: 500; }
.drop-hint  { font-size: 10px; opacity: 0.7; line-height: 1.5; }

/* ── Button ── */
button.action {
  width: 100%;
  padding: 6px 8px;
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
button.action:disabled { opacity: 0.38; cursor: default; }
</style>
</head>
<body>

<div class="drop-zone${this.terminalRunning ? "" : " no-terminal"}" id="dropZone">
  <span class="drop-label" id="dropLabel">Drop image or file here</span>
  <span class="drop-hint">🖼 Images: multimodal vision<br>📄 Files: path context</span>
</div>

<button class="action" id="sendSelBtn"
  title="Send the active editor file or selected text to the Pi terminal"
  ${this.terminalRunning ? "" : "disabled"}>📎 Send Active Selection</button>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let isRunning = ${this.terminalRunning};

function send(type, extra) {
  vscode.postMessage({ type, ...extra });
}

// Send Active Selection
document.getElementById('sendSelBtn').addEventListener('click', () => {
  send('sendSelection');
});

function updateTerminalState(running) {
  isRunning = running;
  const btn = document.getElementById('sendSelBtn');
  if (btn) btn.disabled = !running;
  const zone = document.getElementById('dropZone');
  if (zone) {
    if (running) zone.classList.remove('no-terminal');
    else zone.classList.add('no-terminal');
  }
}

// ── Drop zone ─────────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp']);
const DEFAULT_DROP_LABEL = 'Drop image or file here';
const dropZone = document.getElementById('dropZone');
const dropLabel = document.getElementById('dropLabel');

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function setDropState(state, text) {
  const base = 'drop-zone' + (isRunning ? '' : ' no-terminal');
  dropZone.className = base + (state ? ' ' + state : '');
  dropLabel.textContent = text || DEFAULT_DROP_LABEL;
}

function resetDropLater(ms) {
  setTimeout(() => setDropState('', DEFAULT_DROP_LABEL), ms);
}

// Convert a file:// URI to an OS path (handles encoded chars and Windows drive letters)
function fileUriToPath(uri) {
  try {
    if (!uri.startsWith('file://')) return uri;
    let p = decodeURIComponent(uri.slice(7));
    // Strip leading slash on Windows drive paths: /C:/foo -> C:/foo
    if (/^/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return uri;
  }
}

// Read a File as base64 (for OS drops where File.path is empty in webviews)
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const comma = String(result).indexOf(',');
      resolve(comma >= 0 ? String(result).slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Pull dropped items: prefer paths, fall back to in-memory File objects.
function extractDroppedItems(dt) {
  const items = [];
  const seen = new Set();
  const dbg = [];
  if (!dt) return { items, debug: 'no DataTransfer' };

  dbg.push('types=[' + Array.from(dt.types || []).join(',') + ']');
  dbg.push('files=' + (dt.files ? dt.files.length : 0));

  // 1. URI lists — VS Code Explorer drags expose this
  for (const fmt of ['application/vnd.code.uri-list', 'text/uri-list']) {
    const raw = dt.getData(fmt);
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim().replace(/\r$/, '');
      if (!trimmed || trimmed.startsWith('#')) continue;
      const fp = fileUriToPath(trimmed);
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      items.push({ path: fp, name: fp.split('/').pop() || fp });
    }
  }

  // 2. Native File objects (OS file manager drops)
  for (const file of Array.from(dt.files || [])) {
    const p = file.path || '';
    if (p) {
      if (!seen.has(p)) {
        seen.add(p);
        items.push({ path: p, name: file.name });
      }
    } else if (!seen.has('blob:' + file.name + ':' + file.size)) {
      seen.add('blob:' + file.name + ':' + file.size);
      items.push({ file, name: file.name });
    }
  }

  // 3. Plain text fallback (paths dragged as text)
  if (!items.length) {
    const txt = dt.getData('text/plain');
    if (txt && (txt.startsWith('/') || /^[A-Za-z]:[/\\]/.test(txt) || txt.startsWith('file://'))) {
      const fp = fileUriToPath(txt.trim());
      items.push({ path: fp, name: fp.split('/').pop() || fp });
    }
  }

  dbg.push('items=' + items.length);
  return { items, debug: dbg.join(' ') };
}

['dragenter', 'dragover'].forEach(ev => {
  dropZone.addEventListener(ev, e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropZone.classList.add('over');
  });
});
['dragleave', 'dragend'].forEach(ev => {
  dropZone.addEventListener(ev, e => {
    e.preventDefault();
    dropZone.classList.remove('over');
  });
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('over');

  if (!isRunning) {
    setDropState('error', '⚠ No Pi terminal running — open Pi Agent first');
    resetDropLater(2500);
    return;
  }

  const { items, debug } = extractDroppedItems(e.dataTransfer);
  console.log('[Pi drop]', debug);

  if (!items.length) {
    setDropState('error', 'Nothing droppable detected (' + debug + ')');
    resetDropLater(3000);
    return;
  }

  setDropState('over', 'Reading …');
  let imageCount = 0;
  let fileCount = 0;
  try {
    for (const item of items) {
      const isImage = IMAGE_EXTS.has(extOf(item.name));
      if (item.path) {
        send('dropFile', { filePath: item.path, isImage });
      } else if (item.file) {
        const base64 = await fileToBase64(item.file);
        send('dropFile', { fileName: item.name, fileBase64: base64, isImage });
      } else {
        continue;
      }
      if (isImage) imageCount++; else fileCount++;
    }
  } catch (err) {
    setDropState('error', 'Read failed: ' + (err && err.message ? err.message : err));
    resetDropLater(2500);
    return;
  }

  const parts = [];
  if (imageCount) parts.push(imageCount + ' image' + (imageCount > 1 ? 's' : ''));
  if (fileCount)  parts.push(fileCount + ' file' + (fileCount > 1 ? 's' : ''));
  setDropState('success', '✓ Sent ' + parts.join(' + '));
  resetDropLater(1800);
});

// Block the global window from hijacking the drop
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

// Messages from extension
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'terminalState':
      updateTerminalState(msg.running);
      break;
    case 'dropError':
      setDropState('error', '⚠ ' + msg.message);
      resetDropLater(3000);
      break;
  }
});

send('ready');
</script>
</body>
</html>`;
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface DropWebviewMessage {
	type: string;
	filePath?: string;
	isImage?: boolean;
	fileName?: string;
	fileBase64?: string;
}
