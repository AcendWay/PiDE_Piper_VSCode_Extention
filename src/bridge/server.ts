import * as crypto from "node:crypto";
import * as http from "node:http";
import type * as vscode from "vscode";
import { handleBridgeAction } from "./handlers";
import { createBridgeState } from "./state";
import type { BridgeRequest, BridgeResponse } from "./types";

export interface Bridge {
	url: string;
	token: string;
	state: ReturnType<typeof createBridgeState>;
	dispose: () => Promise<void>;
}

/**
 * Start the HTTP bridge server.
 *
 * Listens on 127.0.0.1 (or 0.0.0.0 on Windows so WSL2 can reach it).
 * Returns the bound URL, a security token, and a dispose function.
 */
export async function createBridge(
	context: vscode.ExtensionContext,
	onTerminalSession: (terminalId: string, sessionFile: string) => void,
): Promise<Bridge> {
	const token = crypto.randomBytes(24).toString("hex");
	const bindHost = process.platform === "win32" ? "0.0.0.0" : "127.0.0.1";

	const state = createBridgeState(onTerminalSession);

	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/bridge") {
			res.writeHead(404).end();
			return;
		}

		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => {
			void (async () => {
				let parsed: BridgeRequest;
				try {
					parsed = JSON.parse(body) as BridgeRequest;
				} catch {
					const r: BridgeResponse = { ok: false, error: "Invalid JSON" };
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify(r));
					return;
				}

				if (parsed.token !== token) {
					const r: BridgeResponse = {
						ok: false,
						error: "Invalid bridge token",
					};
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify(r));
					return;
				}

				try {
					const result = await handleBridgeAction(
						parsed.action,
						parsed.payload,
						state,
						context,
					);
					const r: BridgeResponse = { ok: true, result };
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(r));
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					const r: BridgeResponse = { ok: false, error: msg };
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(r));
				}
			})();
		});
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.listen(0, bindHost, () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				resolve(addr.port);
			} else {
				reject(new Error("Bridge server failed to bind"));
			}
		});
		server.on("error", reject);
	});

	const listenHost = process.platform === "win32" ? "127.0.0.1" : "127.0.0.1";
	const url = `http://${listenHost}:${port}`;

	return {
		url,
		token,
		state,
		dispose: () =>
			new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
