import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export const IS_WIN = process.platform === "win32";

/** Common install locations searched in order when no explicit path is configured. */
const AUTO_DETECT_PATHS = [
	path.join(process.env.HOME ?? "~", ".bun", "bin", "pi"),
	path.join(process.env.HOME ?? "~", ".local", "bin", "pi"),
	path.join(process.env.HOME ?? "~", ".npm-global", "bin", "pi"),
	path.join(
		process.env.HOME ?? "~",
		".nvm",
		"versions",
		"node",
		"*",
		"bin",
		"pi",
	),
];

/** Convert a Windows absolute path to its /mnt/<drive>/... WSL equivalent. */
export function winToWslPath(winPath: string): string {
	return winPath
		.replace(/\\/g, "/")
		.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

/**
 * In WSL2 NAT mode the Windows host is reachable at the nameserver address
 * in /etc/resolv.conf. In mirrored-networking mode 127.0.0.1 also works.
 */
export function getWslHostIp(): string {
	try {
		const out = child_process.execSync("wsl.exe cat /etc/resolv.conf", {
			encoding: "utf8",
			timeout: 3000,
		});
		const m = out.match(/nameserver\s+([\d.]+)/);
		if (m) return m[1];
	} catch {
		// fall through
	}
	return "127.0.0.1";
}

/** Resolve a glob-style path pattern (single wildcard segment supported). */
function resolveGlob(pattern: string): string | undefined {
	const segments = pattern.split(path.sep);
	const wildcardIdx = segments.findIndex((s) => s === "*");
	if (wildcardIdx === -1) return pattern;

	const base = segments.slice(0, wildcardIdx).join(path.sep);
	const rest = segments.slice(wildcardIdx + 1).join(path.sep);
	try {
		const entries = fs.readdirSync(base).sort().reverse(); // prefer newer versions
		for (const entry of entries) {
			const candidate = path.join(base, entry, rest);
			if (fs.existsSync(candidate)) return candidate;
		}
	} catch {
		// directory doesn't exist
	}
	return undefined;
}

let _piBinaryCache: string | undefined;

/** Find the pi binary, checking config override first then auto-detect paths. */
export function findPiBinary(): string {
	if (_piBinaryCache) return _piBinaryCache;

	const cfg = vscode.workspace.getConfiguration("piSidebar");
	const override = cfg.get<string>("piExecutable", "");
	if (override) {
		_piBinaryCache = override;
		return override;
	}

	for (const pattern of AUTO_DETECT_PATHS) {
		const resolved = pattern.includes("*") ? resolveGlob(pattern) : pattern;
		if (resolved && fs.existsSync(resolved)) {
			_piBinaryCache = resolved;
			return resolved;
		}
	}

	// Last resort: rely on PATH
	_piBinaryCache = "pi";
	return "pi";
}

/** Clear the binary cache (call when settings change). */
export function clearPiBinaryCache(): void {
	_piBinaryCache = undefined;
}

/**
 * Ensure a pi binary is available. If not found, offer to install it.
 * Returns the resolved path, or undefined if the user cancelled.
 */
export async function ensurePiBinary(): Promise<string | undefined> {
	const piPath = findPiBinary();
	if (piPath !== "pi") return piPath; // found via auto-detect

	// Verify PATH binary exists
	try {
		child_process.execSync(IS_WIN ? `where ${piPath}` : `which ${piPath}`, {
			stdio: "ignore",
		});
		return piPath;
	} catch {
		// Not on PATH
	}

	const choice = await vscode.window.showErrorMessage(
		"Pi binary not found. Install it globally?",
		"npm",
		"bun",
		"Cancel",
	);
	if (!choice || choice === "Cancel") return undefined;

	clearPiBinaryCache();
	const installCmd =
		choice === "bun"
			? "bun add -g @mariozechner/pi-coding-agent"
			: "npm install -g @mariozechner/pi-coding-agent";
	const terminal = vscode.window.createTerminal({ name: "Install Pi" });
	terminal.show();
	terminal.sendText(installCmd);
	return undefined;
}

/**
 * Build the shell args array passed to the pi binary when starting a session.
 * bridgeExtensionPath: absolute path to piVscodeTools.js
 */
export function buildPiArgs(options: {
	bridgeExtensionPath: string;
	model?: string;
	sessionFile?: string;
	extraArgs?: string[];
	initialPrompt?: string;
}): string[] {
	const args: string[] = ["--extension", options.bridgeExtensionPath];

	if (options.model) {
		args.push("--model", options.model);
	}
	if (options.sessionFile) {
		args.push("--session", options.sessionFile);
	}

	const cfg = vscode.workspace.getConfiguration("piSidebar");
	const startupArgs = cfg.get<string[]>("startupArgs", []);
	args.push(...startupArgs);

	if (options.extraArgs?.length) {
		args.push(...options.extraArgs);
	}

	const prompt = options.initialPrompt ?? cfg.get<string>("initialPrompt", "");
	if (prompt.trim()) {
		args.push("--append-system-prompt", decoratePrompt(prompt));
	}

	return args;
}

function decoratePrompt(prompt: string): string {
	const folder =
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "No workspace";
	const platform = IS_WIN ? "Windows (WSL2 pi)" : "Linux/WSL";
	return (
		`${prompt}\n\n` +
		`VS Code startup context:\n` +
		`- Platform: ${platform}\n` +
		`- Workspace: ${folder}\n` +
		`- Bridge tools available: vscode_context, vscode_open_file, vscode_show_diff, ` +
		`vscode_command, and more (call vscode_get_editor_state for full state)`
	);
}

/** Build environment variables passed to the pi process. */
export function buildPiEnv(bridgeConfig: {
	url: string;
	token: string;
}): Record<string, string> {
	return {
		PI_VSCODE_BRIDGE_URL: bridgeConfig.url,
		PI_VSCODE_BRIDGE_TOKEN: bridgeConfig.token,
	};
}

/** Detect the package manager used to install pi for upgrade purposes. */
export function guessPiPackageManager(
	piPath: string,
): "npm" | "bun" | undefined {
	if (piPath.includes(".bun")) return "bun";
	if (piPath.includes("npm") || piPath.includes(".nvm")) return "npm";
	return undefined;
}

/** Upgrade pi binary and run `pi update` for installed packages. */
export async function upgradePi(): Promise<void> {
	const piPath = await ensurePiBinary();
	if (!piPath) return;

	let manager = guessPiPackageManager(piPath);
	if (!manager) {
		const choice = await vscode.window.showQuickPick(["npm", "bun"], {
			placeHolder:
				"Could not detect package manager. Choose one to upgrade Pi:",
		});
		if (!choice) return;
		manager = choice as "npm" | "bun";
	}

	const upgradeCmd =
		manager === "bun"
			? "bun add -g @mariozechner/pi-coding-agent"
			: "npm install -g @mariozechner/pi-coding-agent";

	const terminal = vscode.window.createTerminal({ name: "Upgrade Pi" });
	terminal.show();
	terminal.sendText(`${upgradeCmd} && ${piPath} update`);
}
