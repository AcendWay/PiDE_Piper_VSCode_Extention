import * as crypto from "node:crypto";
import type * as vscode from "vscode";
import type { Bridge } from "../bridge/server";
import { PackageManager, fetchNpmPackages } from "../packages";

export class PackagesViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.packages";
	private readonly pkgManager = new PackageManager();
	private cachedPackages: unknown[] = [];
	private cachedError: string | undefined;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _bridge: Bridge,
	) {
		// Start fetching the marketplace immediately and cache it; the webview
		// will pull the cached value once it signals "ready".
		void fetchNpmPackages((packages) => {
			this.cachedPackages = packages;
		}).catch((err: Error) => {
			this.cachedError = err.message;
		});
	}

	dispose(): void {
		this.pkgManager.dispose();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html(view.webview);

		const post = (msg: unknown) => void view.webview.postMessage(msg);

		view.webview.onDidReceiveMessage(
			async (msg: { type: string; package?: string }) => {
				switch (msg.type) {
					case "ready":
						// Webview is now listening; flush cached state and fetch fresh.
						if (this.cachedPackages.length)
							post({ type: "packages", packages: this.cachedPackages });
						else if (this.cachedError)
							post({ type: "packagesError", error: this.cachedError });
						void this.pkgManager.refreshInstalled(post);
						// Kick a fresh marketplace fetch (also updates cache)
						void fetchNpmPackages((packages) => {
							this.cachedPackages = packages;
							post({ type: "packages", packages });
						}).catch((err: Error) => {
							this.cachedError = err.message;
							post({ type: "packagesError", error: err.message });
						});
						break;
					case "install":
						if (msg.package) await this.pkgManager.install(msg.package, post);
						break;
					case "uninstall":
						if (msg.package) await this.pkgManager.uninstall(msg.package, post);
						break;
					case "cancel":
						this.pkgManager.cancel();
						post({ type: "opEnd" });
						break;
					case "upgrade":
						await this.pkgManager.upgrade();
						void this.pkgManager.refreshInstalled(post);
						break;
					case "refresh":
						void this.pkgManager.refreshInstalled(post);
						void fetchNpmPackages((packages) => {
							this.cachedPackages = packages;
							post({ type: "packages", packages });
						}).catch((err: Error) => {
							post({ type: "packagesError", error: err.message });
						});
						break;
				}
			},
		);
	}

	private html(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString("hex");
		void webview;
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src https: data:; media-src https:; connect-src https:;">
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
  display: flex; flex-direction: column; gap: 6px; padding: 10px;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
  flex-shrink: 0;
}
.search-row { display: flex; gap: 6px; }
input.search {
  flex: 1; background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px; padding: 5px 8px; font-size: 12px;
  font-family: inherit; outline: none;
  transition: border-color 0.15s;
}
input.search:focus { border-color: var(--vscode-focusBorder); }
.icon-btn {
  background: none; border: none;
  color: var(--vscode-foreground);
  cursor: pointer; font-size: 14px; padding: 4px 6px;
  opacity: 0.7; border-radius: 4px; flex-shrink: 0;
  transition: opacity 0.15s, background 0.15s;
}
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

.filters { display: flex; gap: 4px; flex-wrap: wrap; }
.filter-pill {
  font-size: 10px; padding: 3px 9px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid transparent; border-radius: 999px; cursor: pointer;
  font-family: inherit; opacity: 0.55;
  transition: opacity 0.15s, border-color 0.15s;
}
.filter-pill.active {
  opacity: 1;
  border-color: var(--vscode-focusBorder, transparent);
}
.filter-pill:hover { opacity: 1; }

.upgrade-btn {
  width: 100%;
  padding: 6px; background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none; border-radius: 4px; cursor: pointer;
  font-size: 11px; font-family: inherit;
  transition: background 0.15s;
}
.upgrade-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* Installed section — user-resizable via splitter, collapsible via chevron */
.installed-section {
  display: flex; flex-direction: column;
  flex-shrink: 0;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
  /* height controlled inline by splitter; default set in JSX */
  min-height: 28px;
}
.installed-section.collapsed { height: 28px !important; }
.installed-section.collapsed .installed-body { display: none; }
.installed-header {
  padding: 6px 10px; cursor: pointer;
  display: flex; justify-content: space-between; align-items: center;
  user-select: none; flex-shrink: 0;
}
.installed-header:hover { background: var(--vscode-list-hoverBackground); }
.installed-header-left {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.07em; color: var(--vscode-descriptionForeground);
}
.chevron { display: inline-block; transition: transform 0.15s; font-size: 10px; }
.installed-section.collapsed .chevron { transform: rotate(-90deg); }
.installed-body {
  flex: 1; overflow-y: auto; padding: 0 10px 8px;
}
.splitter {
  height: 4px; cursor: row-resize; flex-shrink: 0;
  background: var(--vscode-widget-border, transparent);
  transition: background 0.15s;
}
.splitter:hover, .splitter.dragging {
  background: var(--vscode-focusBorder, #007acc);
}
.section-title {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.07em; color: var(--vscode-descriptionForeground);
  margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;
}
.installed-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 3px 0; font-size: 11px; gap: 6px;
}
.installed-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uninstall-btn {
  font-size: 10px; padding: 2px 8px;
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--vscode-foreground); border: none; border-radius: 3px; cursor: pointer;
  font-family: inherit;
  transition: filter 0.15s;
}
.uninstall-btn:hover { filter: brightness(1.15); }

/* Package list */
.pkg-list { flex: 1; overflow-y: auto; padding: 0 0 8px; }
.pkg-card {
  padding: 10px;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
  transition: background 0.15s;
}
.pkg-card:hover { background: var(--vscode-list-hoverBackground); }
.pkg-header { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 4px; }
.pkg-name { font-size: 12px; font-weight: 600; flex: 1; min-width: 0; line-height: 1.4; }
.pkg-name a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.pkg-name a:hover { text-decoration: underline; }
.pkg-labels { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; }
.label-badge {
  font-size: 9px; padding: 2px 6px; border-radius: 3px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  text-transform: lowercase;
}
.pkg-desc { font-size: 11px; color: var(--vscode-foreground); margin-bottom: 4px; opacity: 0.9; line-height: 1.4; }
.pkg-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
.pkg-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
.install-btn {
  font-size: 10px; padding: 3px 10px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; border-radius: 3px; cursor: pointer; font-family: inherit;
  transition: background 0.15s;
}
.install-btn:hover { background: var(--vscode-button-hoverBackground); }
.install-btn.uninstall {
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
}
.install-btn.uninstall:hover { filter: brightness(1.15); background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
.preview-toggle {
  font-size: 10px; color: var(--vscode-textLink-foreground);
  background: none; border: none; cursor: pointer; padding: 0; font-family: inherit;
}
.preview-toggle:hover { text-decoration: underline; }
.pkg-media { margin: 4px 0; border-radius: 4px; overflow: hidden; display: none; }
.pkg-media.visible { display: block; }
.pkg-media img, .pkg-media video { width: 100%; display: block; border-radius: 4px; }
.status { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
.footer-link { padding: 8px 10px; text-align: right; font-size: 10px; flex-shrink: 0;
  border-top: 1px solid var(--vscode-widget-border, transparent); }
.footer-link a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.footer-link a:hover { text-decoration: underline; }

/* ── Op overlay ── */
.op-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,0.65); z-index: 100;
  flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  padding: 16px;
}
.op-overlay.visible { display: flex; }
.op-log {
  width: 100%; max-height: 240px; overflow-y: auto;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border, transparent);
  border-radius: 5px; padding: 10px;
  font-size: 11px; font-family: var(--vscode-editor-font-family, monospace);
  white-space: pre-wrap; word-break: break-all; color: var(--vscode-foreground);
}
.op-title { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); }
.cancel-btn {
  padding: 5px 16px; background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--vscode-foreground); border: none; border-radius: 3px;
  cursor: pointer; font-size: 11px; font-family: inherit;
}
</style>
</head>
<body>

<div class="toolbar">
  <div class="search-row">
    <input class="search" id="search" type="text" placeholder="Search packages…">
    <button class="icon-btn" id="refreshBtn" title="Refresh">↻</button>
  </div>
  <div class="filters" id="filters">
    <button class="filter-pill active" data-filter="all">All</button>
    <button class="filter-pill" data-filter="extensions">Extensions</button>
    <button class="filter-pill" data-filter="skills">Skills</button>
    <button class="filter-pill" data-filter="prompts">Prompts</button>
    <button class="filter-pill" data-filter="themes">Themes</button>
  </div>
  <button class="upgrade-btn" id="upgradeBtn">↑ Upgrade Pi &amp; Packages</button>
</div>

<div class="installed-section" id="installedSection" style="display:none; height: 180px;">
  <div class="installed-header" id="installedHeader" title="Click to collapse / expand">
    <span class="installed-header-left">
      <span class="chevron">▾</span>
      <span>Installed</span>
      <span id="installedCount"></span>
    </span>
  </div>
  <div class="installed-body" id="installedList"></div>
</div>
<div class="splitter" id="splitter" title="Drag to resize" style="display:none"></div>

<div class="pkg-list" id="pkgList">
  <div class="status" id="loadingState">Loading marketplace…</div>
</div>

<div class="op-overlay" id="opOverlay">
  <div class="op-title" id="opTitle">Working…</div>
  <div class="op-log" id="opLog"></div>
  <button class="cancel-btn" id="cancelBtn">Cancel</button>
</div>
<div class="footer-link">
  <a href="https://pi.dev/packages" target="_blank">Browse pi.dev/packages ↗</a>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let allPackages = [];
let installedSet = new Set();
let activeFilter = 'all';
let searchQuery = '';

function send(type, extra) { vscode.postMessage({ type, ...extra }); }

function esc(s) {
  const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML;
}

function renderInstalled() {
  const sec = document.getElementById('installedSection');
  const splitter = document.getElementById('splitter');
  const list = document.getElementById('installedList');
  const count = document.getElementById('installedCount');
  if (!installedSet.size) {
    sec.style.display = 'none';
    splitter.style.display = 'none';
    return;
  }
  sec.style.display = 'flex';
  if (!sec.classList.contains('collapsed')) splitter.style.display = 'block';
  count.textContent = '(' + installedSet.size + ')';
  list.innerHTML = [...installedSet].map(pkg =>
    '<div class="installed-item">' +
      '<span class="installed-name" title="' + esc(pkg) + '">' + esc(pkg) + '</span>' +
      '<button class="uninstall-btn" data-action="uninstall" data-pkg="' + esc(pkg) + '">Remove</button>' +
    '</div>'
  ).join('');
}

function renderPackages() {
  const list = document.getElementById('pkgList');
  if (!allPackages.length) {
    list.innerHTML = '<div class="status">Loading marketplace…<br><small>Fetching from npm registry</small></div>';
    return;
  }
  const q = searchQuery;
  const f = activeFilter;
  const filtered = allPackages.filter(p => {
    if (f !== 'all' && !(p.piLabels || []).includes(f)) return false;
    if (!q) return true;
    return (p.name + ' ' + p.description + ' ' + (p.keywords || '')).toLowerCase().includes(q);
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="status">No packages match your filter.</div>';
    return;
  }

  list.innerHTML = filtered.map((p, i) => {
    const labels = (p.piLabels || []).map(l => '<span class="label-badge">' + esc(l) + '</span>').join('');
    const labelsRow = labels ? '<div class="pkg-labels">' + labels + '</div>' : '';
    const pkgKey = 'npm:' + p.name;
    const isInstalled = installedSet.has(pkgKey);
    const installBtn = isInstalled
      ? '<button class="install-btn uninstall" data-action="uninstall" data-pkg="' + esc(pkgKey) + '">Uninstall</button>'
      : '<button class="install-btn" data-action="install" data-pkg="' + esc(pkgKey) + '">Install</button>';
    const hasMedia = p.image || p.video;
    const previewBtn = hasMedia ? '<button class="preview-toggle" data-action="preview" data-idx="' + i + '">▾ preview</button>' : '';
    const media = hasMedia ? '<div class="pkg-media" id="media-' + i + '">' +
      (p.video
        ? '<video src="' + esc(p.video) + '" controls muted playsinline preload="metadata"></video>'
        : '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '" loading="lazy">') +
      '</div>' : '';
    const repoLink = p.repo ? ' <a href="' + esc(p.repo) + '" target="_blank">repo</a>' : '';
    return '<div class="pkg-card">' +
      '<div class="pkg-header"><div class="pkg-name"><a href="' + esc(p.npm) + '" target="_blank">' + esc(p.name) + '</a>' + repoLink + '</div>' +
      installBtn + '</div>' +
      labelsRow +
      media +
      '<div class="pkg-desc">' + esc(p.description) + '</div>' +
      '<div class="pkg-meta">v' + esc(p.version) + (p.author ? ' · ' + esc(p.author) : '') + '</div>' +
      '<div class="pkg-actions">' + previewBtn + '</div>' +
    '</div>';
  }).join('');
}

// ── Collapse / expand the Installed accordion ────────────────────────────
document.getElementById('installedHeader').addEventListener('click', () => {
  const sec = document.getElementById('installedSection');
  const splitter = document.getElementById('splitter');
  const collapsed = sec.classList.toggle('collapsed');
  splitter.style.display = collapsed ? 'none' : 'block';
});

// ── Drag the splitter to resize Installed vs Marketplace ────────────────
(function setupSplitter() {
  const splitter = document.getElementById('splitter');
  const sec = document.getElementById('installedSection');
  let dragging = false;
  let startY = 0;
  let startHeight = 0;
  splitter.addEventListener('mousedown', (e) => {
    if (sec.classList.contains('collapsed')) return;
    dragging = true;
    startY = e.clientY;
    startHeight = sec.getBoundingClientRect().height;
    splitter.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newHeight = Math.max(40, Math.min(window.innerHeight - 120, startHeight + (e.clientY - startY)));
    sec.style.height = newHeight + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
  });
})();

// ── Event delegation (no inline handlers) ─────────────────────────
document.getElementById('search').addEventListener('input', (e) => {
  searchQuery = e.target.value.toLowerCase();
  renderPackages();
});
document.getElementById('refreshBtn').addEventListener('click', () => send('refresh'));
document.getElementById('upgradeBtn').addEventListener('click', () => send('upgrade'));
document.getElementById('cancelBtn').addEventListener('click', () => send('cancel'));

document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-pill');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  document.querySelectorAll('.filter-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.filter === activeFilter);
  });
  renderPackages();
});

document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'install' || action === 'uninstall') {
    const pkg = btn.dataset.pkg;
    if (pkg) send(action, { package: pkg });
  } else if (action === 'preview') {
    const idx = btn.dataset.idx;
    const el = document.getElementById('media-' + idx);
    if (el) {
      const visible = el.classList.toggle('visible');
      btn.textContent = visible ? '▴ hide' : '▾ preview';
    }
  }
});

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'packages') {
    allPackages = msg.packages || [];
    renderPackages();
    return;
  }
  if (msg.type === 'packagesError') {
    document.getElementById('pkgList').innerHTML =
      '<div class="status">Failed to load packages.<br>' + esc(msg.error || 'Unknown error') + '</div>';
    return;
  }
  if (msg.type === 'installed') {
    installedSet = new Set(msg.packages || []);
    renderInstalled();
    renderPackages();
  }
  if (msg.type === 'opStart') {
    document.getElementById('opLog').textContent = '';
    document.getElementById('opOverlay').classList.add('visible');
  }
  if (msg.type === 'opOutput') {
    const log = document.getElementById('opLog');
    log.textContent += msg.text;
    log.scrollTop = log.scrollHeight;
  }
  if (msg.type === 'opEnd') {
    document.getElementById('opOverlay').classList.remove('visible');
  }
});

// Tell the extension we are ready to receive messages
send('ready');
</script>
</body>
</html>`;
	}
}
