#!/usr/bin/env bash
# Install Pi Sidebar extension directly into VS Code Server's extensions directory.
# Run from the extension root: bash install.sh  (or: npm run install-ext)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

EXT_ID="local.pi-vscode-sidebar-0.0.1"
VSCODE_SERVER_BIN=$(ls -d ~/.vscode-server/bin/*/ 2>/dev/null | sort | tail -1)

if [[ -z "$VSCODE_SERVER_BIN" ]]; then
	echo "❌  VS Code Server not found at ~/.vscode-server/bin/. Open a WSL folder in VS Code first."
	exit 1
fi

VSCODE_NODE="${VSCODE_SERVER_BIN}node"
VSCODE_NODE_VER=$("$VSCODE_NODE" --version)
echo "✔  VS Code Server node: $VSCODE_NODE_VER"

# Verify node-pty binary is compatible with VS Code Server's node
PTY_BINARY="$SCRIPT_DIR/node_modules/node-pty/build/Release/pty.node"
if [[ ! -f "$PTY_BINARY" ]]; then
	echo "❌  node-pty binary not found. Run: npm run rebuild-pty"
	exit 1
fi

# Quick ABI check: load the binary with vscode's node
BINARY_OK=$("$VSCODE_NODE" -e "require('$PTY_BINARY'); console.log('ok')" 2>&1 || true)
if [[ "$BINARY_OK" != "ok" ]]; then
	echo "❌  node-pty ABI mismatch for $VSCODE_NODE_VER. Run: npm run rebuild-pty"
	echo "    Error: $BINARY_OK"
	exit 1
fi
echo "✔  node-pty ABI verified"

# Install destination
EXT_DIR=~/.vscode-server/extensions/"$EXT_ID"
echo "📂  Installing to: $EXT_DIR"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"

# Copy compiled output
cp -r dist media src node_modules package.json "$EXT_DIR/"

echo ""
echo "✅  Installed! Now:"
echo "   1. In VS Code: press Ctrl+Shift+P → 'Developer: Restart Extension Host'"
echo "      (or close and reopen the folder if that doesn't pick it up)"
echo "   3. The π Pi icon appears in the left activity bar."
echo "   4. To move Pi to the RIGHT sidebar: right-click the π icon → 'Move to Secondary Side Bar'."
echo "      VS Code remembers this. Do it once and it stays."
