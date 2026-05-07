import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as https from "node:https";
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

// ── npm registry fetch (runs in extension host, not webview) ─────────────────

export interface NpmPackage {
	name: string;
	description: string;
	version: string;
	author: string;
	keywords: string;
	npm: string;
	repo: string;
	piLabels: string[];
	image: string;
	video: string;
}

function httpsGet(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{ headers: { "User-Agent": "pi-vscode-sidebar/0.1" } },
			(res) => {
				let data = "";
				res.on("data", (chunk: Buffer) => {
					data += chunk.toString();
				});
				res.on("end", () => resolve(data));
			},
		);
		req.on("error", reject);
		req.setTimeout(15_000, () => {
			req.destroy();
			reject(new Error("npm registry request timed out"));
		});
	});
}

/**
 * Fetch packages from the npm registry tagged with `pi-package`.
 * Calls onBatch after each enrichment batch so the UI can update progressively.
 */
export async function fetchNpmPackages(
	onBatch: (packages: NpmPackage[]) => void,
): Promise<void> {
	const searchUrl =
		"https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250";

	const raw = await httpsGet(searchUrl);
	const data = JSON.parse(raw) as {
		objects: Array<{ package: {
			name: string;
			description?: string;
			version?: string;
			keywords?: string[];
			publisher?: { username?: string };
			author?: { name?: string };
			links?: { npm?: string; repository?: string };
		} }>;
	};

	const packages: NpmPackage[] = (data.objects ?? []).map((o) => ({
		name: o.package.name,
		description: o.package.description ?? "",
		version: o.package.version ?? "",
		author:
			o.package.publisher?.username ?? o.package.author?.name ?? "",
		keywords: (o.package.keywords ?? []).join(" "),
		npm:
			o.package.links?.npm ??
			`https://www.npmjs.com/package/${o.package.name}`,
		repo: o.package.links?.repository ?? "",
		piLabels: [],
		image: "",
		video: "",
	}));

	// Send the initial list immediately so the UI isn't blank
	onBatch(packages);

	// Enrich with pi section metadata in batches of 10
	const BATCH = 10;
	for (let i = 0; i < packages.length; i += BATCH) {
		await Promise.all(
			packages.slice(i, i + BATCH).map(async (p) => {
				try {
					const pkgRaw = await httpsGet(
						`https://registry.npmjs.org/${encodeURIComponent(p.name)}/latest`,
					);
					const pkg = JSON.parse(pkgRaw) as {
						pi?: {
							extensions?: unknown[];
							skills?: unknown[];
							prompts?: unknown[];
							themes?: unknown[];
							image?: string;
							video?: string;
						};
					};
					if (pkg?.pi && typeof pkg.pi === "object") {
						const pi = pkg.pi;
						const labels: string[] = [];
						if (pi.extensions?.length) labels.push("extensions");
						if (pi.skills?.length) labels.push("skills");
						if (pi.prompts?.length) labels.push("prompts");
						if (pi.themes?.length) labels.push("themes");
						p.piLabels = labels;
						if (pi.image) p.image = pi.image;
						if (pi.video) p.video = pi.video;
					}
				} catch {
					// individual package fetch failure is non-fatal
				}
			}),
		);
		onBatch(packages); // progressive update after each batch
	}
}



// ── Package operations manager ────────────────────────────────────────────────

export class PackageManager {
	private activeProcess: ChildProcess | undefined;
	private outputChannel?: vscode.OutputChannel;

	/** Refresh the installed list and post to webview. */
	async refreshInstalled(postMessage: (msg: unknown) => void): Promise<void> {
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
