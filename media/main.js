const vscode = acquireVsCodeApi();
const terminalEl = document.getElementById("terminal");
const statusEl = document.getElementById("status");
const term = new Terminal({
	cursorBlink: true,
	convertEol: false,
	fontFamily: "Berkeley Mono, JetBrains Mono, Menlo, Consolas, monospace",
	fontSize: 13,
	lineHeight: 1.12,
	theme: {
		background: "#090b0a",
		foreground: "#d8dbc8",
		cursor: "#f6d365",
		selectionBackground: "#3a4635",
		black: "#111411",
		red: "#ff6b6b",
		green: "#9be564",
		yellow: "#f6d365",
		blue: "#64d2ff",
		magenta: "#ff8bd1",
		cyan: "#6fffe9",
		white: "#f0f1e8",
		brightBlack: "#53584f",
		brightRed: "#ff8787",
		brightGreen: "#b6f27c",
		brightYellow: "#ffe08a",
		brightBlue: "#8bdfff",
		brightMagenta: "#ffa8df",
		brightCyan: "#9ffff0",
		brightWhite: "#ffffff",
	},
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(terminalEl);
term.focus();

function fit() {
	fitAddon.fit();
	vscode.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
}

term.onData((data) => vscode.postMessage({ type: "input", data }));
window.addEventListener("resize", fit);
document
	.getElementById("restart")
	.addEventListener("click", () => vscode.postMessage({ type: "restart" }));
document
	.getElementById("selection")
	.addEventListener("click", () =>
		vscode.postMessage({ type: "sendSelection" }),
	);
window.addEventListener("message", (event) => {
	const msg = event.data;
	if (msg.type === "data") term.write(msg.data);
	if (msg.type === "clear") term.clear();
	if (msg.type === "status") statusEl.textContent = msg.text;
	if (msg.type === "exit")
		statusEl.textContent =
			`exited ${msg.exitCode ?? ""} ${msg.signal ?? ""}`.trim();
});

setTimeout(fit, 50);
vscode.postMessage({ type: "ready" });
