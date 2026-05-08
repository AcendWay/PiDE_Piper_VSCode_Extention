# Changelog

All notable changes to **PiDE Piper** are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.3.3] — 2026-05-07

### Added
- **PiDE Piper branding** — new logo, updated display name, and website badge linking to [PiEDPiPER.dev](https://PiEDPiPER.dev)
- **Version sync script** (`scripts/sync-version.js`) — keeps `package.json`, `package-lock.json`, and any other version references in sync automatically on `npm version` or `npm run package`
- **Demo screenshot** in README showing the full PiDE Piper VS Code setup
- **File to Context** sidebar panel (renamed from *Drop Context*, marked Work in Progress)

### Changed
- Pi package references updated to new [earendil-works](https://github.com/earendil-works/pi) home

---

## [0.3.2] — 2026-04-XX

### Fixed
- Sidebar model switching no longer requires a terminal restart — live in-place model switch restored after regression

---

## [0.3.1] — 2026-04-XX

### Fixed
- Escape sequence corruption in `piVscodeTools.js` model fallback path that caused garbled output in the Pi terminal

---

## [0.3.0] — 2026-04-XX

### Added
- **Project-lifetime cost row** — cumulative spend tracked across sessions, persisted in workspace state, reconciled on reload (Phase 2 #23)
- **Stacked context bar** — segmented token breakdown (System / User / Assistant / Tool I/O / Cache) with tooltip and live cost display (Phase 2 #22)
- **Restart Current Session** — non-destructive one-turn rewind; original session preserved (Phase 2 #21)
- **New Pi Tab button** — opens an additional Pi terminal with a distinct palette color; OSC 2 escape sequences provide live tab titles (Phase 2 #20)
- **Agent state machine** — tab strip dots indicate agent state: 🟢 active · 🟡 idle · ⚪ stale · 🔴 error (Phase 2 #19)
- **Live model switching** — model changed via `pi.setModel` with no terminal restart required (Phase 2 #18)
- **Multi-tab bridge state + mini tab strip** — click-to-focus tab strip in the sidebar; each tab independently tracked by the bridge (Phase 2 #17)

---

## [0.2.0] — 2026-03-XX

### Added
- **Robust agent connection** — improved handshake and reconnection logic between VS Code bridge and Pi terminal
- **Phase 1 — Native terminal** — replaced xterm.js webview with a genuine VS Code terminal (`vscode.window.createTerminal`); full clipboard, scrollback, fonts, and resize at zero cost
- **Binary auto-detection** — searches `~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`, and `$PATH`; prompts to install if not found
- **HTTP bridge server** — replaced raw TCP socket with a clean `POST /bridge` HTTP endpoint; token-protected
- **Terminal profile** — Pi Agent appears in the VS Code *New Terminal* dropdown
- **`Ctrl+Alt+P` / `Cmd+Alt+P` keybinding** — opens or focuses the Pi terminal from anywhere
- **WSL / Windows support** — spawns via `wsl.exe`, bridges across the host/WSL boundary
- **Auto-start** — opens a Pi terminal automatically when VS Code activates (configurable)
- **Phase 2 — Sidebar control panel** — model selector, context window indicator, live active file row, quick actions (Send Context, Review Diffs)
- **Phase 3 — Session manager** — session tracking, restore on VS Code reload, visual session tree grouped by date with Resume and Fork actions
- **Phase 4 — Package manager** — npm marketplace browser with capability filters (extensions / skills / prompts / themes), install/uninstall/upgrade with live output streaming
- **Phase 5 — Expanded bridge (25+ tools)** — LSP inspection tools (definitions, references, hover, diagnostics, symbols, code actions), action tools (open file, save, format, apply workspace edits, show notification), notification event buffer, selection caching, context usage reporting
- **Phase 6 — Drag & drop** — images sent as multimodal vision context; files sent as path context; drop zone UI in sidebar

### Fixed
- CSP-blocked sidebar interactions resolved; webview content security policy tightened correctly

### Removed
- `@xterm/xterm`, `@xterm/addon-fit`, `node-pty` — no longer needed with native terminal
- `media/main.js` webview terminal script

---

## [0.1.0] — 2026-02-XX

### Added
- Initial release — xterm.js webview terminal running the Pi binary
- Basic sidebar with Pi activity bar icon
- MIT license
- Project feature plan (`PLAN.md`) covering Phases 1–6

---

[0.3.3]: https://github.com/AcendWay/PiDE_Piper_VSCode_Extention/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/AcendWay/PiDE_Piper_VSCode_Extention/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/AcendWay/PiDE_Piper_VSCode_Extention/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/AcendWay/PiDE_Piper_VSCode_Extention/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AcendWay/PiDE_Piper_VSCode_Extention/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AcendWay/PiDE_Piper_VSCode_Extention/releases/tag/v0.1.0
