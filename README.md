# Pi Sidebar VS Code Extension

Local-only VS Code extension that runs the Pi coding agent TUI in a sidebar.

## What it does

- Starts `pi` inside a real pseudo-terminal backed by `node-pty`.
- Renders the TUI in a sidebar webview using xterm.js.
- Starts in the active workspace folder, so Pi stays project-aware.
- Adds local bridge tools to Pi:
  - `vscode_context` — active file, selection, visible editors, diagnostics, git changes.
  - `vscode_open_file` — open files/locations in VS Code.
  - `vscode_show_diff` — open VS Code diff views.
  - `vscode_command` — run VS Code commands by id.
- Commands:
  - `Pi: Focus Sidebar`
  - `Pi: Restart Agent`
  - `Pi: Send Active File/Selection Context`
  - `Pi: Review Git Diffs`

## Local development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5`. A separate **Extension Development Host** window is expected; that is how VS Code tests extensions. The Pi sidebar should reveal automatically. If it does not, open Command Palette in the new window and run `Pi: Focus Sidebar`, or click the Pi activity-bar icon.

## Settings

- `piSidebar.piExecutable`: path/command for Pi. Default: `pi`.
- `piSidebar.startupArgs`: extra Pi args, e.g. `["--model", "sonnet:high"]`.
- `piSidebar.initialPrompt`: startup context prompt.
- `piSidebar.autoStart`: start Pi when the view opens.
- `piSidebar.showOnStartup`: automatically reveal the Pi sidebar after F5 launch.

## Troubleshooting

If F5 only shows the compile task output, look in the **new Extension Development Host window**, not the original development window.

If the Pi icon/sidebar is still missing:

1. In the new window, run `Developer: Show Running Extensions` and confirm `Pi Sidebar` is listed.
2. Run `Pi: Focus Sidebar` from Command Palette.
3. Run `Developer: Toggle Developer Tools` and check the Console for activation errors.
4. Native `node-pty` load failures usually mean dependencies need reinstalling from the same shell environment that launches VS Code:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   npm run compile
   ```

## Notes

This is intentionally not marketplace-ready. It runs trusted local code and exposes a localhost bridge so Pi can ask VS Code to inspect editor state, show diffs, and run commands.
