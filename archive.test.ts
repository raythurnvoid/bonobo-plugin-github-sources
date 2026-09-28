import { describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";

import { ArchiveError, keep_path, read_archive } from "./src/archive.js";

function stream(bytes: Uint8Array, chunkSize = 733) {
	let position = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (position === bytes.length) { controller.close(); return; }
			controller.enqueue(bytes.slice(position, position + chunkSize));
			position = Math.min(bytes.length, position + chunkSize);
		},
	});
}

async function accepted(files: Record<string, Uint8Array>) {
	const result: { path: string; content: string }[] = [];
	await read_archive(stream(zipSync(files)), (entry) => {
		if (entry.content !== null) result.push({ path: entry.path, content: entry.content });
		return Promise.resolve();
	});
	return result;
}

describe("keep_path", () => {
	test.each(["README.md", "src/index.ts", "a/b/c/file.txt"])("keeps %s", (path) => {
		expect(keep_path(path)).toBe(true);
	});
	test.each([
		"", "/etc/passwd", "C:/win", "../escape", "a/../b", "a//b", "a\\b", "a/./b", "a/hidden\0.txt",
		"node_modules/dep/index.js", "dist/bundle.js", ".git/config", "pnpm-lock.yaml", "YARN.LOCK",
		"assets/logo.png", "bin/tool.wasm", "vendor/source.ts", "a/coverage/result.json",
	])("refuses %s", (path) => { expect(keep_path(path)).toBe(false); });
});

describe("read_archive", () => {
	test("keeps text and skips folders, binaries, lockfiles and LFS pointers", async () => {
		expect(await accepted({
			"repo/": new Uint8Array(),
			"repo/README.md": strToU8("hello"),
			"repo/src/main.ts": strToU8("export {}"),
			"repo/pnpm-lock.yaml": strToU8("lock"),
			"repo/node_modules/a.js": strToU8("dependency"),
			"repo/logo.png": new Uint8Array([1, 2]),
			"repo/pointer.txt": strToU8("version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"),
			"repo/binary.txt": new Uint8Array([0xff, 0xfe]),
			"repo/nul.txt": new Uint8Array([65, 0, 66]),
			"repo/../escape.txt": strToU8("bad"),
		})).toEqual([{ path: "README.md", content: "hello" }, { path: "src/main.ts", content: "export {}" }]);
	});
	test("accepts 900000 bytes and skips 900001 bytes", async () => {
		const result = await accepted({ "repo/exact.txt": strToU8("a".repeat(900_000)), "repo/large.txt": strToU8("a".repeat(900_001)) });
		expect(result.map((entry) => [entry.path, entry.content.length])).toEqual([["exact.txt", 900_000]]);
	});
	test("preserves UTF-8 and its byte order mark", async () => {
		expect(await accepted({ "repo/é.txt": strToU8("\ufeff你好 👋") })).toEqual([{ path: "é.txt", content: "\ufeff你好 👋" }]);
	});
	test.each<Record<string, Uint8Array>>([
		{ "first/a.txt": strToU8("a"), "second/b.txt": strToU8("b") },
		{ "loose.txt": strToU8("a") },
		{ "../bad.txt": strToU8("a") },
		{ "bad\0root/a.txt": strToU8("a") },
	])("refuses an archive without one safe root", async (files) => {
		await expect(accepted(files)).rejects.toBeInstanceOf(ArchiveError);
	});
	test("refuses a missing end record after complete local entries", async () => {
		const bytes = zipSync({ "repo/a.txt": strToU8("a") });
		await expect(read_archive(stream(bytes.slice(0, -22)), async () => {})).rejects.toThrow("ZIP end record is missing");
	});
	test("refuses a wrong directory CRC after valid decompression", async () => {
		const bytes = zipSync({ "repo/a.txt": strToU8("a") });
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const directory = view.getUint32(bytes.length - 22 + 16, true);
		bytes[directory + 16] = bytes[directory + 16] ^ 1;
		await expect(read_archive(stream(bytes), async () => {})).rejects.toThrow("ZIP entry checksum or size does not match");
	});
	test("caps the compressed stream even without a Content-Length header", async () => {
		const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1)); } });
		await expect(read_archive(body, async () => {})).rejects.toThrow("ZIP compressed size exceeds 12 MiB");
	});
	test("refuses more than 5000 accepted files", async () => {
		const files = Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [`repo/f${index}.txt`, strToU8("a")]));
		await expect(accepted(files)).rejects.toThrow("Repository exceeds the copy cap");
	});
	test("counts excluded entries against the archive entry limit", async () => {
		const files = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`repo/dist/f${index}.txt`, strToU8("a")]));
		await expect(accepted(files)).rejects.toThrow("ZIP has too many entries");
	});
	test("refuses non-byte archive chunks", async () => {
		const body = new ReadableStream<unknown>({ start(controller) { controller.enqueue("zip"); controller.close(); } });
		await expect(read_archive(body, () => Promise.resolve())).rejects.toThrow("ZIP stream must contain bytes");
	});
	test("cancels the reader when its consumer pauses", async () => {
		let canceled = false;
		const bytes = zipSync({ "repo/a.txt": strToU8("a") });
		const body = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(bytes); },
			cancel() { canceled = true; },
		});
		await expect(read_archive(body, () => Promise.reject(new Error("pause")))).rejects.toThrow("pause");
		expect(canceled).toBe(true);
	});
});
