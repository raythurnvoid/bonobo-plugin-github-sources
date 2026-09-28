import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build({
	absWorkingDir: root,
	entryPoints: ["src/worker.ts"],
	outfile: resolve(root, "dist/backend/worker.js"),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2024",
	minify: false,
	legalComments: "inline",
});
