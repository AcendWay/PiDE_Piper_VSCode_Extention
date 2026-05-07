#!/usr/bin/env node
/**
 * sync-version.js
 *
 * Single source of truth: package.json "version"
 *
 * What this script updates automatically:
 *   - README.md  — version badge URL  (shields.io)
 *
 * Run manually:      node scripts/sync-version.js
 * Runs automatically via npm lifecycle hooks:
 *   - postversion   (after `npm version patch|minor|major`)
 *   - prepackage    (before `npm run package`)
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = pkg.version;

// ── README.md ─────────────────────────────────────────────────────────────────
const readmePath = path.join(root, "README.md");
const readme = fs.readFileSync(readmePath, "utf8");

// Matches: https://img.shields.io/badge/version-X.Y.Z-<color>
const badgeRe = /(https:\/\/img\.shields\.io\/badge\/version-)[\d.]+(-)/g;
const updatedReadme = readme.replace(badgeRe, `$1${version}$2`);

if (updatedReadme !== readme) {
	fs.writeFileSync(readmePath, updatedReadme, "utf8");
	console.log(`✔  README.md   version badge → ${version}`);
} else {
	console.log(`·  README.md   already at ${version}`);
}

console.log(`\n   Version: ${version}  (source: package.json)\n`);
