import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import { findPiBinary, upgradePi } from "./pi";

// ── Installed package parsing ─────────────────────────────────────────────────

export interface InstalledPackage {
	source: string;
	path: string;
}

export function getInstalledPackages(
	piPath: string,
): Promise<InstalledPackage[]> {
	return new Promise((resolve) => {
		execFile(piPath, ["list"], { timeout: 10_000 }, (_err, stdout) => {
			resolve(parseInstalledOutput(stdout ?? ""));
		});
	});
}

function parseInstalledOutput(output: string): InstalledPackage[] {
	const packages: InstalledPackage[] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? "";
		if (
			trimmed.startsWith("npm:") ||
			trimmed.startsWith("github:") ||
			trimmed.startsWith("http")
		) {
			const pkgPath = lines[i + 1]?.trim() ?? "";
			packages.push({ source: trimmed, path: pkgPath });
		}
	}
	return packages;
}

// ── Package operations manager ────────────────────────────────────────────────

export class PackageManager {
	private activeProcess: ChildProcess | undefined;
	private outputChannel?: vscode.OutputChannel;

	/** Refresh the installed list and post to webview. */
	async refreshInstalled(
		postMessage: (msg: unknown) => void,
	): Promise<void> {
		const piPath = findPiBinary();
		const packages = await getInstalledPackages(piPath);
		postMessage({
			type: "installed",
			packages: packages.map((p) => p.source),
		});
	}

	/** Install a package, streaming output. */
	async install(
		pkg: string,
		postMessage: (msg: unknown) => void,
	): Promise<void> {
		return this.runCommand(["install", pkg], postMessage);
	}

	/** Uninstall a package, streaming output. */
	async uninstall(
		pkg: string,
		postMessage: (msg: unknown) => void,
	): Promise<void> {
		return this.runCommand(["remove", pkg], postMessage);
	}

	/** Upgrade pi binary + installed packages. */
	async upgrade(): Promise<void> {
		await upgradePi();
	}

	/** Cancel the running operation. */
	cancel(): void {
		this.activeProcess?.kill();
		this.activeProcess = undefined;
	}

	get isBusy(): boolean {
		return !!this.activeProcess;
	}

	private runCommand(
		args: string[],
		postMessage: (msg: unknown) => void,
	): Promise<void> {
		if (this.activeProcess) {
			vscode.window.showWarningMessage(
				"Pi: Another package operation is already in progress.",
			);
			return Promise.resolve();
		}

		const piPath = findPiBinary();

		return new Promise((resolve) => {
			postMessage({ type: "opStart" });

			const proc = spawn(piPath, args, { stdio: ["ignore", "pipe", "pipe"] });
			this.activeProcess = proc;

			const onData = (chunk: Buffer) => {
				postMessage({ type: "opOutput", text: chunk.toString() });
			};
			proc.stdout?.on("data", onData);
			proc.stderr?.on("data", onData);

			proc.on("close", async () => {
				this.activeProcess = undefined;
				postMessage({ type: "opEnd" });
				// Refresh installed list after operation completes
				await this.refreshInstalled(postMessage);
				resolve();
			});

			proc.on("error", (err) => {
				this.activeProcess = undefined;
				postMessage({ type: "opOutput", text: `Error: ${err.message}\n` });
				postMessage({ type: "opEnd" });
				resolve();
			});
		});
	}

	dispose(): void {
		this.activeProcess?.kill();
		this.outputChannel?.dispose();
	}
}
