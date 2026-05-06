const net = require("node:net");
const { Type } = require("typebox");

function callVsCode(action, payload) {
	const port = Number(process.env.PI_VSCODE_BRIDGE_PORT || "0");
	const token = process.env.PI_VSCODE_BRIDGE_TOKEN || "";
	if (!port || !token)
		throw new Error(
			"VS Code bridge unavailable. Start Pi from the Pi Sidebar extension.",
		);

	return new Promise((resolve, reject) => {
		const socket = net.createConnection({
			host: process.env.PI_VSCODE_BRIDGE_HOST || "127.0.0.1",
			port,
		});
		let data = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("VS Code bridge timed out"));
		}, 30_000);

		socket.on("connect", () =>
			socket.write(JSON.stringify({ token, action, payload }) + "\n"),
		);
		socket.on("data", (chunk) => (data += chunk.toString("utf8")));
		socket.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			try {
				const msg = JSON.parse(data || "{}");
				if (msg.ok)
					resolve(
						typeof msg.result === "string"
							? msg.result
							: JSON.stringify(msg.result, null, 2),
					);
				else reject(new Error(msg.error || "VS Code bridge failed"));
			} catch (err) {
				reject(err);
			}
		});
	});
}

function textResult(text) {
	return { content: [{ type: "text", text }], details: {} };
}

module.exports = (pi) => {
	pi.registerTool({
		name: "vscode_context",
		label: "VS Code Context",
		description:
			"Get active workspace, active editor, selected text, visible editors, diagnostics, and git diff summary from VS Code.",
		parameters: Type.Object({
			includeDiff: Type.Optional(
				Type.Boolean({ description: "Include git diff summary" }),
			),
			includeDiagnostics: Type.Optional(
				Type.Boolean({ description: "Include VS Code diagnostics" }),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("context", params));
		},
	});

	pi.registerTool({
		name: "vscode_open_file",
		label: "VS Code Open File",
		description: "Open a file in VS Code, optionally at a 1-based line/column.",
		parameters: Type.Object({
			path: Type.String({
				description: "Workspace-relative or absolute file path",
			}),
			line: Type.Optional(Type.Number()),
			column: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("openFile", params));
		},
	});

	pi.registerTool({
		name: "vscode_show_diff",
		label: "VS Code Show Diff",
		description:
			"Open VS Code's diff viewer for a file against HEAD or for two explicit file URIs/paths.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Workspace-relative file path to compare against git HEAD",
				}),
			),
			left: Type.Optional(
				Type.String({ description: "Left absolute path or URI" }),
			),
			right: Type.Optional(
				Type.String({ description: "Right absolute path or URI" }),
			),
			title: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("showDiff", params));
		},
	});

	pi.registerTool({
		name: "vscode_command",
		label: "VS Code Command",
		description:
			"Execute a VS Code command by id. Use for local-only editor integrations when ordinary shell tools are insufficient.",
		parameters: Type.Object({
			command: Type.String({
				description: "VS Code command id, e.g. workbench.view.scm",
			}),
			argsJson: Type.Optional(
				Type.String({ description: "JSON array of command arguments" }),
			),
		}),
		async execute(_id, params) {
			return textResult(await callVsCode("command", params));
		},
	});
};
