import type * as vscode from "vscode";

/**
 * Sessions sidebar view — Phase 1 placeholder.
 * Full visual session tree implemented in Phase 3 (issues #10, #11).
 */
export class SessionsViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "piSidebar.sessions";

	constructor(private readonly context: vscode.ExtensionContext) {}

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
</style>
</head>
<body>
  <div class="icon">📋</div>
  <div class="title">Session History</div>
  <div class="sub">
    Visual session tree with resume &amp; fork coming in Phase 3.<br>
    Sessions will appear here once tracked.
  </div>
</body>
</html>`;
	}
}
