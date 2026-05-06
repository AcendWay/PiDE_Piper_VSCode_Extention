# Pi VS Code Extension — Full Feature Plan

## Goal

Evolve the Pi Sidebar from a basic xterm.js webview terminal into a fully-featured,
native-feeling VS Code integration. The agent session runs as a **native VS Code terminal**
(full clipboard, text wrap, scrollback, fonts for free). The sidebar becomes an intelligent
**management and awareness layer**: model selection, context usage, session history tree,
and a package marketplace.

---

## Architecture Overview

```
Activity Bar: π
│
├── [Control Panel]   WebviewView — model selector, context indicator, quick actions
├── [Sessions]        WebviewView — visual session history tree, restore/fork
└── [Packages]        WebviewView — npm marketplace + locally installed packages

Native VS Code Terminal (beside editor by default, configurable)
│   shellPath = pi binary
│   shellArgs = --extension <bridge-extension> [--session <file>] [--model <name>] ...
│   Clipboard, text wrap, scrollback, resize — all handled by VS Code natively

Bridge Server (localhost HTTP, token-protected)
│   pi-side extension (piVscodeTools.js) calls the bridge
│   20+ tools: editor state, LSP, code actions, workspace edits, format, notifications
│   Context usage reporting (pi polls → bridge stores → sidebar reads)
│   Live footer push (bridge pushes editor state → pi updates its status bar)
```

---

## Source Structure

```
src/
├── extension.ts              # Activation, command registration, subscriptions
├── pi.ts                     # Binary auto-detect, env vars, arg builders
├── terminal.ts               # Native terminal creation, column/location logic
├── sessions.ts               # Session file tracking, workspace-state persistence, restore
├── models.ts                 # Model list discovery, active model state, switch logic
├── upgrade.ts                # pi upgrade + pi update logic
├── bridge/
│   ├── server.ts             # HTTP bridge server (replaces TCP)
│   ├── handlers.ts           # All bridge action handlers (20+ tools)
│   ├── state.ts              # Shared bridge state: selections, notifications, context usage
│   ├── serialize.ts          # Serialization helpers (LSP types → plain objects)
│   └── types.ts              # Shared TypeScript types
├── views/
│   ├── controlView.ts        # Model selector + context indicator + quick actions webview
│   ├── sessionsView.ts       # Visual session tree webview
│   └── packagesView.ts       # npm marketplace + installed packages webview
└── bridge-extension/
    └── piVscodeTools.js      # Pi-side extension loaded via --extension flag
```

---

## Removed Dependencies

| Package            | Reason                                 |
| ------------------ | -------------------------------------- |
| `@xterm/xterm`     | Native terminal replaces webview xterm |
| `@xterm/addon-fit` | No longer needed                       |
| `node-pty`         | No longer needed                       |
| `media/main.js`    | Webview terminal JS removed            |
| `media/styles.css` | Replaced per-view                      |

---

## Phase 1 — Core Migration: Native Terminal

**Goal:** Replace the xterm.js webview session with a native VS Code terminal.
Clipboard, text wrapping, scrollback, and resize work immediately.

### 1.1 Binary Auto-Detection (`pi.ts`)

Search for the `pi` binary in order:

1. `piSidebar.piExecutable` setting (user override)
2. `~/.bun/bin/pi`
3. `~/.local/bin/pi`
4. `~/.npm-global/bin/pi`
5. `pi` on `$PATH`

If not found, offer to install via a Quick Pick (npm / bun).

### 1.2 Native Terminal Creation (`terminal.ts`)

```ts
vscode.window.createTerminal({
  name: "Pi Agent",
  shellPath: piPath,
  shellArgs: ["--extension", bridgeExtensionPath, ...userArgs],
  location: { viewColumn: ViewColumn.Beside }, // default, configurable
  isTransient: true,
  cwd: workspaceRoot,
  env: { PI_VSCODE_BRIDGE_URL, PI_VSCODE_BRIDGE_TOKEN },
  iconPath: { light: "assets/logo-light.svg", dark: "assets/logo.svg" },
});
```

- `findPiColumn()` — reuses existing Pi terminal instead of opening a duplicate
- `findUnusedColumn()` — falls back to next empty column
- Setting `piSidebar.terminalLocation`: `"beside"` (default) | `"panel"` | `"active"`

### 1.3 Bridge Migration (HTTP)

Switch from raw TCP socket to HTTP for cleaner request/response and easier expansion:

```
POST http://127.0.0.1:<port>/bridge
Authorization: Bearer <token>
Content-Type: application/json

{ "action": "getEditorState", "payload": {} }
```

piVscodeTools.js updated to use `http.request` instead of raw TCP socket.

### 1.4 Status Bar Button

```ts
const item = vscode.window.createStatusBarItem(StatusBarAlignment.Right, 100);
item.text = "$(pi-logo) Pi";
item.tooltip = "Open Pi Terminal";
item.command = "piSidebar.open";
item.show();
```

### 1.5 Terminal Profile

Register pi as a selectable terminal profile so it appears in the New Terminal dropdown:

```ts
vscode.window.registerTerminalProfileProvider("piSidebar.terminalProfile", {
  provideTerminalProfile() {
    return new vscode.TerminalProfile({ name: "Pi Agent", shellPath: piPath, ... })
  }
})
```

### 1.6 Updated Commands

| Command                   | Keybinding       | Description                                          |
| ------------------------- | ---------------- | ---------------------------------------------------- |
| `piSidebar.open`          | `Ctrl+Alt+P`     | Open or focus Pi terminal                            |
| `piSidebar.openWithFile`  | Editor title bar | Open Pi with current file + cursor/selection context |
| `piSidebar.sendSelection` | —                | Send selected text to Pi terminal                    |
| `piSidebar.reviewDiffs`   | —                | Ask Pi to review git diffs                           |
| `piSidebar.restart`       | —                | Kill and reopen Pi terminal                          |
| `piSidebar.upgrade`       | —                | Upgrade pi binary + `pi update` packages             |
| `piSidebar.selectModel`   | —                | Open model selector quick pick                       |

### 1.7 WSL Handling

Preserve existing `winToWslPath` + `getWslHostIp` logic. Adapt for native terminal:
on Windows, use `shellPath: "wsl.exe"`, `shellArgs: ["--cd", wslCwd, "--", piPath, ...args]`.

---

## Phase 2 — Sidebar Control Panel (`controlView.ts`)

**Goal:** Replace the old xterm.js webview with a rich control panel in the sidebar.

### 2.1 Layout

```
┌─────────────────────────────────┐
│  π Pi Agent            [Open ▶] │
├─────────────────────────────────┤
│  Model                          │
│  ┌─────────────────────────┐    │
│  │ claude-sonnet-4     ▼  │    │
│  └─────────────────────────┘    │
│  [View all available models]    │
├─────────────────────────────────┤
│  Context Window                 │
│  ██████████░░░░░░░  58k/200k   │
│  29% used                       │
├─────────────────────────────────┤
│  Active File                    │
│  src/extension.ts  :142  TS  ●  │
│  ⚠ 2 errors  ⚠ 1 warning       │
├─────────────────────────────────┤
│  [Send Context]  [Review Diffs] │
└─────────────────────────────────┘
```

### 2.2 Model Selector

- Default list: models read from `~/.pi/agent/config.json` (or equivalent) + models
  the user has previously used (stored in extension global state)
- Dropdown shows top models; "View all available models" expands the full list
- Selecting a model:
  - If terminal is running: sends the appropriate pi command to switch models mid-session
    (e.g. `/model claude-opus-4` or the pi-native model switch command)
  - On next terminal open: passes `--model <name>` to shell args
- Model name persisted in workspace state so it survives restarts

### 2.3 Context Window Indicator

- pi-side extension (`piVscodeTools.js`) hooks into pi's session events and calls a
  bridge action `reportContextUsage({ used: 58000, total: 200000 })` whenever usage changes
- Bridge state stores last reported value
- Control panel webview polls bridge every 3s via `getContextUsage` action
- Rendered as a styled progress bar with `used / total` and percentage
- Turns amber at 75%, red at 90%

### 2.4 Live Active File Status

- Bridge state tracks the active editor (file, language, cursor, dirty flag, diagnostic counts)
  updated via VS Code event listeners (`onDidChangeActiveTextEditor`, `onDidChangeDiagnostics`)
- pi-side extension polls `getStatus` every 4s and updates pi's footer status bar line
- Control panel also reads this and shows it as a compact info row

---

## Phase 3 — Session Manager (`sessions.ts` + `sessionsView.ts`)

**Goal:** Track, persist, and visually browse pi session history. Support restore and fork.

### 3.1 Session Tracking

When a pi terminal starts, the bridge extension calls `reportTerminalSession`:

```json
{
  "action": "reportTerminalSession",
  "payload": { "terminalId": "uuid", "sessionFile": "/path/to/session.json" }
}
```

Extension saves `{ terminalId → sessionFile }` to `context.workspaceState`.

### 3.2 Session Restore on Reload

On activation, read saved session map from workspace state, verify each session file
still exists, and reopen terminals with `--session <file>` for valid entries.

### 3.3 Session Metadata

Read each session JSON file to extract:

- Session name / ID
- Created timestamp, last-active timestamp
- Model used
- Message count
- Parent session ID (if forked) — enables tree structure
- Summary (first user message or pi-provided title if available)

### 3.4 Visual Session Tree

```
Sessions                         [↻]
├── 📂 Today
│   ├── 🟢 refactor auth module
│   │   claude-sonnet-4 · 23 msgs · 2h ago  [Resume] [Fork]
│   └── 🔵 fix CI pipeline
│       claude-opus-4 · 8 msgs · 4h ago     [Resume] [Fork]
└── 📂 Yesterday
    └── ⚪ initial setup
        claude-sonnet-4 · 41 msgs · 1d ago  [Resume] [Fork]
```

- Grouped by date (Today / Yesterday / This Week / Older)
- Forked sessions shown indented under their parent
- Status indicators: 🟢 active, 🔵 restored, ⚪ closed
- **[Resume]** — reopens terminal with `--session <file>`
- **[Fork]** — opens new terminal with `--session <file> --fork` (if pi supports) or
  copies session file and opens fresh
- Click session name → expands to show first few messages as preview
- Search bar to filter by name/date

---

## Phase 4 — Package Manager (`packagesView.ts`)

**Goal:** Browse the pi.dev/npm ecosystem and manage locally installed packages.

### 4.1 Data Sources

- **Marketplace**: `GET https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250`
  - For each result, fetch `https://registry.npmjs.org/<name>/latest` to read `pkg.pi` section
    for capability labels (extensions / skills / prompts / themes) and media assets
- **Installed**: Run `pi list` and parse output into `{ source, path }[]`

### 4.2 Layout

```
Packages                    [Upgrade Pi & Packages]

🔍 [Search packages...        ] [Search]

── Installed (3) ────────────────────────────────
  npm:pi-lens          extension  [Uninstall]
  npm:pi-subagents     extension  [Uninstall]
  npm:context-mode     extension  [Uninstall]

── Marketplace ──────────────────────────────────
Filter: [All ▼]  [extensions] [skills] [prompts] [themes]

┌─────────────────────────────────────────────┐
│ pi-lens                    [extension]       │
│ Real-time code feedback — LSP, linters...    │
│ v3.8.41 · apmantza · 12.8K/mo               │
│ [▶ Preview image]                            │
│                               [Install]      │
└─────────────────────────────────────────────┘
...
```

### 4.3 Capability Filtering

Pill-style toggle filters: `All` | `extensions` | `skills` | `prompts` | `themes`
Filter applied client-side after initial fetch.

### 4.4 Media Previews

- If `pkg.pi.image` is set: show `<img>` lazy-loaded below description
- If `pkg.pi.video` is set: show `<video controls muted playsinline preload="metadata">`
- Collapsed by default ("▶ Show preview"), expand on click to save space

### 4.5 Install / Uninstall Flow

- **Install**: spawn `pi install npm:<package>`, stream stdout/stderr to an output overlay,
  dismiss on close, refresh installed list
- **Uninstall**: spawn `pi remove npm:<package>`, same overlay
- **Cancel**: kill the child process
- Installed packages show "Uninstall" button; uninstalled show "Install"

### 4.6 Upgrade

"Upgrade Pi & Packages" button: auto-detects package manager (npm/bun), runs global upgrade
then `pi update`, streams output.

---

## Phase 5 — Expanded Bridge Tools (`bridge/handlers.ts` + `piVscodeTools.js`)

**Goal:** Expand from 4 to 20+ bridge tools, making Pi a true IDE-aware agent.

### 5.1 Inspection Tools (new)

| Tool                           | Returns                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `vscode_get_editor_state`      | Workspace folders, active editor, selection, open editors |
| `vscode_get_selection`         | Current selection with text, file, coordinates            |
| `vscode_get_latest_selection`  | Last cached selection (survives focus loss to terminal)   |
| `vscode_get_diagnostics`       | Diagnostics for a file or whole workspace                 |
| `vscode_get_open_editors`      | All open editors with language, dirty state               |
| `vscode_get_workspace_folders` | Workspace folder paths                                    |
| `vscode_get_document_symbols`  | File outline from active language server                  |
| `vscode_get_definitions`       | Symbol definition locations at position                   |
| `vscode_get_type_definitions`  | Type definition locations at position                     |
| `vscode_get_implementations`   | Interface/abstract member implementations                 |
| `vscode_get_hover`             | Hover docs, inferred types, signatures from LSP           |
| `vscode_get_workspace_symbols` | Global symbol search                                      |
| `vscode_get_references`        | All references to a symbol                                |
| `vscode_get_code_actions`      | Quick fixes / refactors at a range                        |
| `vscode_get_notifications`     | Buffered events: selection, editor, diagnostics, save     |

### 5.2 Action Tools (new)

| Tool                          | Does                                                               |
| ----------------------------- | ------------------------------------------------------------------ |
| `vscode_open_file`            | Open file, optionally reveal/select a range _(existing, enhanced)_ |
| `vscode_show_diff`            | Show diff viewer _(existing)_                                      |
| `vscode_command`              | Execute any VS Code command _(existing)_                           |
| `vscode_save_document`        | Save a file                                                        |
| `vscode_apply_workspace_edit` | Apply multi-file edits (rename, refactor)                          |
| `vscode_format_document`      | Format a file via active formatter                                 |
| `vscode_format_range`         | Format a selection                                                 |
| `vscode_execute_code_action`  | Apply a quick fix                                                  |
| `vscode_show_notification`    | Show info/warning/error notification to user                       |

### 5.3 Notification Event Buffer

VS Code event listeners push events into a ring buffer in bridge state:

```ts
type BridgeEvent =
  | { type: "selection"; data: SelectionInfo }
  | { type: "activeEditor"; data: EditorInfo }
  | { type: "diagnostics"; data: DiagnosticSummary }
  | { type: "documentSaved"; data: { filePath: string } }
  | { type: "documentDirty"; data: { filePath: string; isDirty: boolean } };
```

pi polls `vscode_get_notifications` to react to workspace changes without prompting.

### 5.4 Selection Caching

When user switches focus to the Pi terminal, `activeTextEditor` becomes undefined.
Extension caches the last selection event so `vscode_get_latest_selection` still works.

### 5.5 Context Usage Reporting

New bridge action called by pi-side extension:

```json
{
  "action": "reportContextUsage",
  "payload": { "used": 58000, "total": 200000 }
}
```

Stored in bridge state; sidebar control panel reads it via `getContextUsage`.

---

## Phase 6 — Drag & Drop (`controlView.ts`)

**Goal:** Accept dragged files in the sidebar control panel.

### 6.1 Image Drop → Multimodal

- User drags an image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`) onto the control panel
- Sidebar detects MIME type or extension
- Sends the absolute file path to the pi terminal:
  ```
  terminal.sendText(`[Image attached: ${filePath}]\r`)
  ```
- Pi picks up the path and uses its multimodal vision capability to "see" the image
- Visual feedback: thumbnail preview flashes briefly in the sidebar drop zone

### 6.2 File Drop → Path Context

- User drags any other file onto the sidebar
- Sends the path as context:
  ```
  terminal.sendText(`[File context: ${filePath}]\r`)
  ```
- The pi session can then read/inspect the file using its normal file tools

### 6.3 Drop Zone UI

The control panel has a dedicated drop zone at the bottom:

```
┌─────────────────────────────────┐
│  Drop image or file here        │
│  🖼  Images: multimodal vision  │
│  📄  Files: path context        │
└─────────────────────────────────┘
```

Highlights on `dragover`, shows preview on `drop`.

---

## Updated `package.json` Contributes

### Views (sidebar)

```json
"views": {
  "piSidebar": [
    { "id": "piSidebar.control",  "name": "Pi Agent",   "type": "webview" },
    { "id": "piSidebar.sessions", "name": "Sessions",   "type": "webview" },
    { "id": "piSidebar.packages", "name": "Packages",   "type": "webview" }
  ]
}
```

### New Commands

```
piSidebar.open               Pi: Open Terminal
piSidebar.openWithFile       Pi: Open with File Context
piSidebar.sendSelection      Pi: Send Selection
piSidebar.reviewDiffs        Pi: Review Git Diffs
piSidebar.restart            Pi: Restart Terminal
piSidebar.upgrade            Pi: Upgrade Pi and Packages
piSidebar.selectModel        Pi: Select Model
piSidebar.newSession         Pi: New Session
piSidebar.restoreSession     Pi: Restore Session
```

### New Settings

```
piSidebar.piExecutable           string   Path override (default: auto-detect)
piSidebar.terminalLocation       enum     "beside" | "panel" | "active"  (default: "beside")
piSidebar.startupArgs            array    Extra args passed to pi
piSidebar.initialPrompt          string   System prompt prefix
piSidebar.autoStart              boolean  Open terminal on sidebar open
piSidebar.showOnStartup          boolean  Reveal sidebar on VS Code start
piSidebar.defaultModel           string   Default model name
piSidebar.restoreSessions        boolean  Restore sessions on reload (default: true)
```

### Terminal Profile

```json
"terminalProfiles": [
  { "id": "piSidebar.terminalProfile", "title": "Pi Agent" }
]
```

---

## Implementation Phases & Rough Order

| Phase | Scope                                                                                     | Complexity |
| ----- | ----------------------------------------------------------------------------------------- | ---------- |
| **1** | Core migration: native terminal, binary detect, HTTP bridge, status bar, terminal profile | Medium     |
| **2** | Control panel: model selector, context indicator, live footer status                      | Medium     |
| **3** | Session manager: tracking, restore on reload, visual tree                                 | High       |
| **4** | Package manager: marketplace search, installed list, install/uninstall, media             | Medium     |
| **5** | Bridge expansion: LSP tools, notification buffer, selection cache, context reporting      | High       |
| **6** | Drag & drop: image → multimodal, file → path context                                      | Low        |

---

## Key Architectural Decisions

- **No xterm.js / node-pty** — removed entirely. Native terminal handles all of this.
- **HTTP bridge** — cleaner than raw TCP, easier to add endpoints, better error handling.
- **Three sidebar views** — Control Panel / Sessions / Packages are independent collapsible
  webviews; each manages its own state and updates independently.
- **Context reporting via push** — pi-side extension pushes context usage to bridge;
  sidebar polls. Avoids needing to parse pi's terminal output stream.
- **Session tree built from files** — session metadata read directly from pi's session
  JSON files; no separate database needed.
- **Model switching** — sidebar sends model-change command to the running terminal for
  mid-session switching; new terminals use the persisted model preference.
- **WSL preserved** — all WSL path translation and host IP detection logic carried forward.

---

## What We're Intentionally Skipping

- ❌ Voice / dictation (no interest)
- ❌ `@pi` VS Code Chat participant (not currently of interest)
- ❌ RPC/chat mode rendering (keep TUI — it's the native pi experience)
- ❌ Mermaid/math rendering inside VS Code (pi's TUI handles its own rendering)
