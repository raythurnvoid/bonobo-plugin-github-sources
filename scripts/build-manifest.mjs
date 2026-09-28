// The root manifest owns the version and hashes. The dist copy is byte-identical.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "bonobo.plugin.json");
const original = readFileSync(manifestPath, "utf8");
const worker = readFileSync(resolve(root, "dist/backend/worker.js"));
const hash = `sha256:${createHash("sha256").update(worker).digest("hex")}`;
const manifestText = original
	.replace(/("sha256"\s*:\s*)"sha256:[a-f0-9]{64}"/, `$1"${hash}"`)
	.replace(/("bytes"\s*:\s*)\d+/, `$1${worker.byteLength}`);
if (manifestText !== original) writeFileSync(manifestPath, manifestText);
const manifest = JSON.parse(manifestText);
if (typeof manifest.version !== "string") throw new Error("Manifest version is missing");
const packagePath = resolve(root, "package.json");
const packageText = readFileSync(packagePath, "utf8");
const updatedPackage = packageText.replace(/("version"\s*:\s*)"[^"]+"/, `$1${JSON.stringify(manifest.version)}`);
if (updatedPackage !== packageText) writeFileSync(packagePath, updatedPackage);
const distPath = resolve(root, "dist/bonobo.plugin.json");
let previousDist = null;
try { previousDist = readFileSync(distPath, "utf8"); } catch { /* First build. */ }
if (previousDist !== manifestText) writeFileSync(distPath, manifestText);
