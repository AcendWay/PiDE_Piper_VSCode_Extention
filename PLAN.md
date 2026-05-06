# Plan

## Goal

Run the existing `pi` CLI as an interactive TUI in VS Code, local-only, with enough VS Code bridge tools for project/editor awareness.

## Architecture

1. VS Code extension contributes a Pi activity-bar container and sidebar webview.
2. Extension host starts a local pseudo-terminal with `node-pty`:
   - command: configurable `piSidebar.piExecutable` (`pi` by default)
   - cwd: first workspace folder
   - args: `--extension src/piVscodeTools.js` plus user `piSidebar.startupArgs`
3. Webview renders the terminal via xterm.js and forwards keyboard/resize events to the pty.
4. Extension host starts a token-protected localhost bridge.
5. The Pi-side extension registers custom tools that call the bridge:
   - `vscode_context`
   - `vscode_open_file`
   - `vscode_show_diff`
   - `vscode_command`

## Local test loop

1. `npm install`
2. `npm run compile`
3. Open this folder in VS Code.
4. Press `F5`.
5. In the Extension Development Host, click the Pi activity-bar icon.
6. Try:
   - type directly into the TUI
   - run `Pi: Send Active File/Selection Context`
   - ask Pi to call `vscode_context` or review diffs

## Known local-only tradeoffs

- `vscode_command` is powerful by design. Use only with trusted local Pi sessions.
- `node-pty` is native. If VS Code cannot load it, reinstall dependencies from the same environment that launches VS Code, then rerun `npm run compile`.
- The webview is a terminal transport, not a reimplementation of Pi's TUI.
