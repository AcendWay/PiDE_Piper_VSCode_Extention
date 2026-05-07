# PiDE Piper — Pi Agent for VS Code

A native VS Code extension that integrates the [pi coding agent](https://pi.dev) into your editor workflow. Pi runs as a **native VS Code terminal** beside your code, with a rich sidebar for model selection, session history, package management, and live editor awareness.

> **Not the pi CLI.** This extension launches your locally installed `pi` binary — your configured providers, models, skills, and extensions all carry over automatically.

---

## What This Is

Pi is a terminal-native AI coding agent. This extension keeps it close to VS Code without reimplementing the agent — pi's full TUI runs as a native terminal tab, while the sidebar gives you management and context tools that would otherwise require typing commands.

The goal is a workflow where:
- Pi always knows what file you're looking at, where your cursor is, and what errors exist
- You can browse and install pi packages without leaving VS Code
- Sessions survive VS Code restarts and can be resumed or forked from a visual history
- Model switching is one click, not a terminal restart by hand
- Dragging a screenshot onto the sidebar sends it directly to pi for multimodal analysis

---

## Features

### Native Terminal Integration
- Pi opens as a **native VS Code terminal** beside the editor — clipboard (`Ctrl+C/V/X`), text wrapping, scrollback, and font rendering all work exactly as in any other terminal
- Pi terminal auto-detects your installed binary from `~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`, and `$PATH`
- Registers as a **terminal profile** so pi appears in the New Terminal dropdown
- `Ctrl+Alt+P` (Mac: `Cmd+Alt+P`) opens or focuses the terminal from anywhere
- WSL2 / Windows supported — spawns via `wsl.exe`, bridges across the host/WSL boundary

### Sidebar: Pi Agent (Control Panel)
The main sidebar view. Always visible while you work:

| Section | What it shows |
|---|---|
| **Status** | Running/stopped indicator + workspace name |
| **Model** | Current model from your pi config; change with one click |
| **Context Window** | Live progress bar: green → amber (75%) → red (90%) |
| **Active File** | Current file, language, cursor position, unsaved dot, error/warning counts |
| **Quick Actions** | Focus Terminal, Send Context, Review Diffs, New Session, Restart |
| **Drop Zone** | Drag images for multimodal vision; drag files to send their path as context |

### Sidebar: Sessions
Visual history of all pi sessions across projects:
- Date-grouped tree: **Today / Yesterday / This Week / Older**
- Each session shows model used, message count, time ago, and first message preview
- **Resume** — reopen the exact conversation in a new terminal
- **Fork** — copy a session and branch from it
- Forked sessions appear as children under their parent
- 🟢 Active / ⚪ Closed status indicators
- Search/filter by name, model, or project path

### Sidebar: Packages
Browse and manage the entire pi package ecosystem without leaving VS Code:
- Fetches the npm `pi-package` keyword registry (~250+ packages)
- Filter by type: **Extensions / Skills / Prompts / Themes**
- Shows capability labels, author, version, and media previews
- **Install** / **Uninstall** with live streamed output and Cancel
- **Installed** section at the top shows what you have
- **Upgrade Pi & Packages** — upgrades the pi binary and all installed packages

### Bridge: 25+ VS Code Tools for Pi
Pi gets full IDE awareness through a local HTTP bridge. Every tool is available in the pi session automatically:

**Editor & workspace**
- `vscode_context` / `vscode_get_editor_state` — full snapshot
- `vscode_get_selection` / `vscode_get_latest_selection` — survives terminal focus
- `vscode_get_open_editors`, `vscode_get_workspace_folders`
- `vscode_get_diagnostics` — errors/warnings for a file or workspace
- `vscode_get_notifications` — poll buffered events (saves, editor switches, diagnostics)

**LSP navigation**
- `vscode_get_document_symbols` — file outline
- `vscode_get_definitions`, `vscode_get_type_definitions`, `vscode_get_implementations`
- `vscode_get_references` — all usages of a symbol
- `vscode_get_hover` — type info and docs at a position
- `vscode_get_workspace_symbols` — global symbol search
- `vscode_get_code_actions` — available quick fixes at a range

**Actions**
- `vscode_open_file` — open a file at a specific line/column
- `vscode_show_diff` — diff viewer against HEAD or between two paths
- `vscode_command` — execute any VS Code command by ID
- `vscode_save_document`, `vscode_apply_workspace_edit`
- `vscode_format_document`, `vscode_format_range`
- `vscode_execute_code_action` — apply a quick fix by index
- `vscode_show_notification` — show a toast in VS Code

**Live feedback to pi's footer**
Pi's TUI status bar updates every 4 seconds with: `src/extension.ts  :142:5  typescript  ● ✗2 ⚠1`

---

## Requirements

- [pi coding agent](https://pi.dev) installed globally (`npm i -g @mariozechner/pi-coding-agent` or `bun add -g @mariozechner/pi-coding-agent`)
- At least one provider API key configured in pi
- VS Code 1.92+

---

## Installation

```bash
git clone https://github.com/AcendWay/PiDE_Piper_VSCode_Extention
cd PiDE_Piper_VSCode_Extention
npm install
npm run package-install
```

Or install from the `.vsix` in the [Releases](https://github.com/AcendWay/PiDE_Piper_VSCode_Extention/releases) tab.

After installing, **reload VS Code** (`Ctrl+Shift+P → Reload Window`). The π icon appears in the activity bar.

---

## Commands

| Command | Keybinding | Description |
|---|---|---|
| **Pi: Open Terminal** | `Ctrl+Alt+P` | Open or focus the Pi terminal |
| **Pi: Open with File Context** | Editor title bar icon | Send current file/cursor/selection context to pi |
| **Pi: Send Active File/Selection Context** | Right-click menu | Send selected text or file info to pi |
| **Pi: Review Git Diffs** | — | Ask pi to review current git changes |
| **Pi: Select Model** | — | Quick Pick model selector (same list as sidebar) |
| **Pi: New Session** | — | Open a fresh pi session |
| **Pi: Restart Terminal** | — | Kill and reopen the pi terminal |
| **Pi: Upgrade Pi and Packages** | — | Upgrade pi binary + `pi update` |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `piSidebar.piExecutable` | *(auto-detect)* | Override the pi binary path |
| `piSidebar.terminalLocation` | `beside` | Where the terminal opens: `beside` / `panel` / `active` |
| `piSidebar.defaultModel` | *(from pi config)* | Override the default model |
| `piSidebar.startupArgs` | `[]` | Extra args passed to pi on start |
| `piSidebar.initialPrompt` | *(VS Code context)* | System prompt prefix injected on session start |
| `piSidebar.restoreSessions` | `true` | Auto-restore sessions when VS Code reloads |
| `piSidebar.showOnStartup` | `true` | Reveal the sidebar when VS Code starts |

---

## Development

```bash
npm install
npm run compile      # one-time build
npm run watch        # rebuild on save
```

Press `F5` to open an **Extension Development Host** with the extension loaded. The Pi sidebar appears automatically. Changes require `npm run compile` + reload.

```bash
npm run package-install   # build .vsix and install it
npm run typecheck         # type-check without emitting
```

### Project structure

```
src/
├── extension.ts              # Activation, commands, event wiring
├── pi.ts                     # Binary detection, env vars, arg builders
├── terminal.ts               # Native terminal creation and management
├── sessions.ts               # Session tracking and workspace-state restore
├── packages.ts               # npm registry fetch, pi list, install/uninstall
├── bridge/
│   ├── server.ts             # HTTP bridge server (token-protected)
│   ├── handlers.ts           # 25+ bridge action handlers
│   ├── listeners.ts          # VS Code event listeners → notification buffer
│   ├── state.ts              # Shared bridge state
│   └── types.ts              # Shared TypeScript types
├── views/
│   ├── controlView.ts        # Model selector, context bar, file status, drop zone
│   ├── sessionsView.ts       # Visual session tree
│   └── packagesView.ts       # Package marketplace
└── bridge-extension/
    └── piVscodeTools.js      # Pi-side extension loaded via --extension flag
```

---

## How the Bridge Works

When pi starts, the extension passes `--extension src/bridge-extension/piVscodeTools.js`. That file registers all the `vscode_*` tools inside pi. Each tool makes an HTTP POST to `http://127.0.0.1:<port>/bridge` with a token and action name. The extension host handles the request using the VS Code API and returns the result as JSON.

On Windows with WSL2, the bridge binds to `0.0.0.0` and pi uses the Windows host IP (read from `/etc/resolv.conf`) instead of `127.0.0.1`.

---

## Roadmap / Known Gaps

- `@pi` VS Code Chat participant (not planned)
- Voice / dictation (not planned)
- The `pi.onSessionFile()` hook is not yet part of pi's public extension API — session restore tracking depends on pi exposing this. The bridge action `reportTerminalSession` is ready and waiting.
- Context window usage bar requires pi to call `vscode_report_context_usage` — currently stubbed pending pi's token event API being public.

---

## Credits

Inspired by [pithings/pi-vscode](https://github.com/pithings/pi-vscode) and [cdervis/vscode-pi](https://github.com/cdervis/vscode-pi). Built on top of the [pi coding agent](https://pi.dev) by Mario Zechner.
