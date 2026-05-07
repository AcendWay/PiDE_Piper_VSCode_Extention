import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { Bridge } from "../bridge/server";
import { PackageManager } from "../packages";

export class PackagesViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.packages";
	private readonly pkgManager = new PackageManager();

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _bridge: Bridge,
	) {}

	dispose(): void { this.pkgManager.dispose(); }

	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html(view.webview);

		const post = (msg: unknown) => void view.webview.postMessage(msg);

		// Seed installed list on open
		void this.pkgManager.refreshInstalled(post);

		view.webview.onDidReceiveMessage(async (msg: { type: string; package?: string }) => {
			switch (msg.type) {
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
					break;
			}
		});
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
  display: flex; gap: 5px; padding: 8px;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
  flex-shrink: 0; flex-wrap: wrap;
}
.search-row { display: flex; gap: 5px; width: 100%; }
input.search {
  flex: 1; background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px; padding: 3px 7px; font-size: 11px;
  font-family: inherit; outline: none;
}
input.search:focus { border-color: var(--vscode-focusBorder); }
.filters { display: flex; gap: 3px; flex-wrap: wrap; width: 100%; }
.filter-pill {
  font-size: 10px; padding: 2px 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: none; border-radius: 999px; cursor: pointer;
  font-family: inherit; opacity: 0.6;
}
.filter-pill.active { opacity: 1; }
.filter-pill:hover { opacity: 1; }
.upgrade-btn {
  width: 100%; margin-top: 3px;
  padding: 4px; background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none; border-radius: 3px; cursor: pointer;
  font-size: 11px; font-family: inherit;
}
.upgrade-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* Installed section */
.installed-section {
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
  flex-shrink: 0; max-height: 160px; overflow-y: auto;
}
.section-title {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--vscode-descriptionForeground);
  margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center;
}
.installed-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 2px 0; font-size: 11px; gap: 6px;
}
.installed-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uninstall-btn {
  font-size: 10px; padding: 1px 6px;
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--vscode-foreground); border: none; border-radius: 2px; cursor: pointer;
  font-family: inherit;
}

/* Package list */
.pkg-list { flex: 1; overflow-y: auto; padding: 0 0 8px; }
.pkg-card {
  padding: 8px 10px;
  border-bottom: 1px solid var(--vscode-widget-border, transparent);
}
.pkg-card:hover { background: var(--vscode-list-hoverBackground); }
.pkg-header { display: flex; align-items: flex-start; gap: 5px; margin-bottom: 3px; }
.pkg-name { font-size: 12px; font-weight: 600; flex: 1; min-width: 0; }
.pkg-name a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.pkg-name a:hover { text-decoration: underline; }
.pkg-labels { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 4px; }
.label-badge {
  font-size: 9px; padding: 1px 5px; border-radius: 2px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.pkg-desc { font-size: 11px; color: var(--vscode-foreground); margin-bottom: 3px; opacity: 0.9; }
.pkg-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 5px; }
.pkg-actions { display: flex; gap: 4px; align-items: center; justify-content: flex-end; }
.install-btn {
  font-size: 10px; padding: 2px 8px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; border-radius: 2px; cursor: pointer; font-family: inherit;
}
.install-btn:hover { background: var(--vscode-button-hoverBackground); }
.install-btn.uninstall {
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
}
.preview-toggle {
  font-size: 10px; color: var(--vscode-textLink-foreground);
  background: none; border: none; cursor: pointer; padding: 0; font-family: inherit;
}
.pkg-media { margin: 4px 0; border-radius: 3px; overflow: hidden; display: none; }
.pkg-media.visible { display: block; }
.pkg-media img, .pkg-media video { width: 100%; display: block; border-radius: 3px; }
.status { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
.footer-link { padding: 6px 10px; text-align: right; font-size: 10px; flex-shrink: 0; }
.footer-link a { color: var(--vscode-textLink-foreground); text-decoration: none; }
/* ── Op overlay ── */
.op-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,0.6); z-index: 100;
  flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 16px;
}
.op-overlay.visible { display: flex; }
.op-log {
  width: 100%; max-height: 220px; overflow-y: auto;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border, transparent);
  border-radius: 4px; padding: 8px;
  font-size: 11px; font-family: var(--vscode-editor-font-family, monospace);
  white-space: pre-wrap; word-break: break-all; color: var(--vscode-foreground);
}
.op-title { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); }
.cancel-btn {
  padding: 4px 14px; background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--vscode-foreground); border: none; border-radius: 3px;
  cursor: pointer; font-size: 11px; font-family: inherit;
}
</style>
</head>
<body>

<div class="toolbar">
  <div class="search-row">
    <input class="search" id="search" type="text"
      placeholder="Search packages…" oninput="onSearch()">
  </div>
  <div class="filters">
    <button class="filter-pill active" data-filter="all" onclick="setFilter('all')">All</button>
    <button class="filter-pill" data-filter="extensions" onclick="setFilter('extensions')">Extensions</button>
    <button class="filter-pill" data-filter="skills" onclick="setFilter('skills')">Skills</button>
    <button class="filter-pill" data-filter="prompts" onclick="setFilter('prompts')">Prompts</button>
    <button class="filter-pill" data-filter="themes" onclick="setFilter('themes')">Themes</button>
  </div>
  <button class="upgrade-btn" onclick="send('upgrade')">↑ Upgrade Pi &amp; Packages</button>
</div>

<div class="installed-section" id="installedSection" style="display:none">
  <div class="section-title">
    <span>Installed</span>
    <span id="installedCount"></span>
  </div>
  <div id="installedList"></div>
</div>

<div class="pkg-list" id="pkgList">
  <div class="status" id="loadingState">Loading packages…</div>
</div>

<div class="op-overlay" id="opOverlay">
  <div class="op-title" id="opTitle">Working…</div>
  <div class="op-log" id="opLog"></div>
  <button class="cancel-btn" onclick="send('cancel')">Cancel</button>
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

function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.filter-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.filter === f);
  });
  renderPackages();
}

function onSearch() {
  searchQuery = document.getElementById('search').value.toLowerCase();
  renderPackages();
}

function toggleMedia(btn, id) {
  const el = document.getElementById('media-' + id);
  if (!el) return;
  const visible = el.classList.toggle('visible');
  btn.textContent = visible ? '▴ hide' : '▾ preview';
}

function renderInstalled() {
  const sec = document.getElementById('installedSection');
  const list = document.getElementById('installedList');
  const count = document.getElementById('installedCount');
  if (!installedSet.size) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  count.textContent = '(' + installedSet.size + ')';
  list.innerHTML = [...installedSet].map(pkg =>
    '<div class="installed-item">' +
      '<span class="installed-name" title="' + esc(pkg) + '">' + esc(pkg) + '</span>' +
      '<button class="uninstall-btn" onclick="send('uninstall',{package:'' + esc(pkg) + ''})">Remove</button>' +
    '</div>'
  ).join('');
}

function renderPackages() {
  const q = searchQuery;
  const f = activeFilter;
  const filtered = allPackages.filter(p => {
    if (f !== 'all' && !(p.piLabels || []).includes(f)) return false;
    if (!q) return true;
    return (p.name + ' ' + p.description + ' ' + (p.keywords || '')).toLowerCase().includes(q);
  });

  if (!filtered.length) {
    document.getElementById('pkgList').innerHTML = '<div class="status">No packages found.</div>';
    return;
  }

  document.getElementById('pkgList').innerHTML = filtered.map((p, i) => {
    const labels = (p.piLabels || []).map(l => '<span class="label-badge">' + esc(l) + '</span>').join('');
    const labelsRow = labels ? '<div class="pkg-labels">' + labels + '</div>' : '';
    const isInstalled = installedSet.has('npm:' + p.name);
    const installBtn = isInstalled
      ? '<button class="install-btn uninstall" onclick="send('uninstall',{package:'npm:' + esc(p.name) + ''})">Uninstall</button>'
      : '<button class="install-btn" onclick="send('install',{package:'npm:' + esc(p.name) + ''})">Install</button>';
    const hasMedia = p.image || p.video;
    const previewBtn = hasMedia ? '<button class="preview-toggle" onclick="toggleMedia(this,'' + i + '')">▾ preview</button>' : '';
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

async function fetchPackages() {
  try {
    const res = await fetch('https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250');
    const data = await res.json();
    allPackages = (data.objects || []).map(o => ({
      name: o.package.name,
      description: o.package.description || '',
      version: o.package.version || '',
      author: o.package.publisher?.username || o.package.author?.name || '',
      keywords: (o.package.keywords || []).join(' '),
      npm: o.package.links?.npm || 'https://www.npmjs.com/package/' + o.package.name,
      repo: o.package.links?.repository || '',
      piLabels: [],
      image: '',
      video: '',
    }));
    renderPackages();

    // Enrich with pi section metadata in batches of 10
    const chunks = [];
    for (let i = 0; i < allPackages.length; i += 10) chunks.push(allPackages.slice(i, i + 10));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (p) => {
        try {
          const r = await fetch('https://registry.npmjs.org/' + encodeURIComponent(p.name) + '/latest');
          const pkg = await r.json();
          if (pkg?.pi && typeof pkg.pi === 'object') {
            const pi = pkg.pi;
            const labels = [];
            if (pi.extensions?.length) labels.push('extensions');
            if (pi.skills?.length) labels.push('skills');
            if (pi.prompts?.length) labels.push('prompts');
            if (pi.themes?.length) labels.push('themes');
            p.piLabels = labels;
            if (pi.image) p.image = pi.image;
            if (pi.video) p.video = pi.video;
          }
        } catch {}
      }));
      renderPackages(); // re-render after each enrichment batch
    }
  } catch (e) {
    document.getElementById('pkgList').innerHTML =
      '<div class="status">Failed to load packages.<br>' + esc(String(e)) + '</div>';
  }
}

window.addEventListener('message', e => {
  const msg = e.data;
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

fetchPackages();
</script>
</body>
</html>`;
	}
}
