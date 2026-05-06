import type * as vscode from "vscode";
import type { Bridge } from "../bridge/server";

/**
 * Packages sidebar view — Phase 1 placeholder.
 * Full npm marketplace + install/uninstall implemented in Phase 4 (issues #12, #13).
 */
export class PackagesViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.packages";

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly bridge: Bridge,
	) {
		void this.bridge; // used in Phase 4
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: false };
		view.webview.html = this.html();
	}

	private html(): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-descriptionForeground);
    padding: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
  }
  .icon { font-size: 28px; margin-bottom: 4px; }
  .title { font-weight: 600; color: var(--vscode-foreground); font-size: 12px; }
  .sub { font-size: 11px; line-height: 1.5; }
  a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
  <div class="icon">📦</div>
  <div class="title">Package Manager</div>
  <div class="sub">
    Browse &amp; install pi packages, skills, and extensions.<br>
    Marketplace browser coming in Phase 4.<br><br>
    <a href="https://pi.dev/packages">Browse pi.dev/packages ↗</a>
  </div>
</body>
</html>`;
	}
}
