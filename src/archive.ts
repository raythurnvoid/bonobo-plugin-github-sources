import { Unzip, UnzipInflate } from "fflate";

const MAX_COMPRESSED_BYTES = 12 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 900_000;
const MAX_COPY_FILES = 5_000;
const MAX_COPY_BYTES = 30_000_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 2 * 1024 * 1024;
const MAX_TAIL_BYTES = MAX_DIRECTORY_BYTES + 65_557;

// These filters match the existing GitHub mirror.
const EXCLUDED_FOLDERS = new Set([
	"node_modules", "dist", "build", "out", ".next", ".turbo", "vendor", ".git", "coverage",
]);
const LOCKFILES = new Set([
	"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "composer.lock", "poetry.lock",
	"gemfile.lock", "bun.lockb",
]);
const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "avif", "heic",
	"woff", "woff2", "ttf", "otf", "eot", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "zst",
	"mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "mkv", "flac", "m4a",
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "wasm", "so", "dylib", "dll", "exe", "o", "a",
	"class", "jar", "node", "sqlite", "db", "bin", "dat", "lockb", "pyc", "pdb",
]);

export class ArchiveError extends Error {
	constructor(readonly kind: "invalid" | "cap", message: string) {
		super(message);
	}
}

export function keep_path(path: string) {
	if (!path || path.length > 1024 || path.startsWith("/") || /^[a-z]:/i.test(path)) return false;
	if (path.includes("\\") || /[\p{Cc}\p{Cf}]/u.test(path)) return false;
	const parts = path.split("/");
	if (parts.length > 64 || parts.some((part) => !part || part === "." || part === ".." || EXCLUDED_FOLDERS.has(part)))
		return false;
	const name = parts.at(-1)!;
	if (LOCKFILES.has(name.toLowerCase())) return false;
	const dot = name.lastIndexOf(".");
	return dot <= 0 || !BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

// CRC is checked against the ZIP directory before a copy can be published.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function update_crc(crc: number, chunk: Uint8Array) {
	for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
	return crc;
}

type Entry = {
	name: string;
	compression: number;
	size?: number;
	originalSize?: number;
	actualSize?: number;
	crc?: number;
};

function check_directory(tail: Uint8Array, totalBytes: number, entries: Entry[]) {
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	let end = tail.length - 22;
	for (; end >= Math.max(0, tail.length - 65_557); end--) {
		if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === tail.length) break;
	}
	if (end < Math.max(0, tail.length - 65_557)) throw new ArchiveError("invalid", "ZIP end record is missing");
	const count = view.getUint16(end + 10, true);
	const size = view.getUint32(end + 12, true);
	const offset = view.getUint32(end + 16, true);
	const absoluteEnd = totalBytes - tail.length + end;
	if (
		view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 ||
		view.getUint16(end + 8, true) !== count || count !== entries.length ||
		count === 65_535 || offset === 0xffffffff || size === 0xffffffff || offset + size !== absoluteEnd
	) throw new ArchiveError("invalid", "ZIP directory does not match the archive");
	if (size > MAX_DIRECTORY_BYTES) throw new ArchiveError("cap", "ZIP directory is too large");
	let cursor = offset - (totalBytes - tail.length);
	if (cursor < 0) throw new ArchiveError("invalid", "ZIP directory is unavailable");
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	for (const entry of entries) {
		if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
			throw new ArchiveError("invalid", "ZIP directory entry is missing");
		const flags = view.getUint16(cursor + 8, true);
		const compression = view.getUint16(cursor + 10, true);
		const crc = view.getUint32(cursor + 16, true);
		const compressedSize = view.getUint32(cursor + 20, true);
		const originalSize = view.getUint32(cursor + 24, true);
		const nameBytes = view.getUint16(cursor + 28, true);
		const extraBytes = view.getUint16(cursor + 30, true);
		const commentBytes = view.getUint16(cursor + 32, true);
		const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
		if (next > end || flags & 1 || ![0, 8].includes(compression) || view.getUint16(cursor + 34, true) !== 0)
			throw new ArchiveError("invalid", "ZIP entry format is not supported");
		let name: string;
		try { name = decoder.decode(tail.subarray(cursor + 46, cursor + 46 + nameBytes)); }
		catch { throw new ArchiveError("invalid", "ZIP names must use UTF-8"); }
		if (
			name !== entry.name || compression !== entry.compression ||
			(entry.size !== undefined && entry.size !== compressedSize) ||
			(entry.originalSize !== undefined && entry.originalSize !== originalSize) ||
			(entry.actualSize !== undefined && entry.actualSize !== originalSize) ||
			(entry.crc !== undefined && entry.crc !== crc) || view.getUint32(cursor + 42, true) >= offset
		) throw new ArchiveError("invalid", "ZIP entry checksum or size does not match");
		cursor = next;
	}
	if (cursor !== end) throw new ArchiveError("invalid", "ZIP directory has extra entries");
}

export async function read_archive(
	body: ReadableStream<unknown>,
	consume: (entry: { index: number; path: string; content: string | null }) => Promise<void>,
) {
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const entries: Entry[] = [];
	const names = new Set<string>();
	const completed: { index: number; path: string; content: string | null; bytes: number }[] = [];
	let topFolder: string | null = null;
	let compressedBytes = 0;
	let expandedBytes = 0;
	let bufferedBytes = 0;
	let copyFiles = 0;
	let copyBytes = 0;
	let tail: Uint8Array<ArrayBuffer> = new Uint8Array();
	const unzip = new Unzip((file) => {
		if (entries.length >= MAX_ENTRIES) throw new ArchiveError("cap", "ZIP has too many entries");
		if (names.has(file.name)) throw new ArchiveError("invalid", "ZIP repeats a path");
		names.add(file.name);
		const slash = file.name.indexOf("/");
		const folder = file.name.slice(0, slash);
		if (slash <= 0 || folder === "." || folder === ".." || folder.includes("\\") || /^[a-z]:/i.test(folder) || /[\p{Cc}\p{Cf}]/u.test(folder))
			throw new ArchiveError("invalid", "ZIP needs one top-level folder");
		topFolder ??= folder;
		if (folder !== topFolder) throw new ArchiveError("invalid", "ZIP has more than one top-level folder");
		if (![0, 8].includes(file.compression)) throw new ArchiveError("invalid", "ZIP compression is not supported");
		const entry: Entry = {
			name: file.name, compression: file.compression, size: file.size, originalSize: file.originalSize,
		};
		const index = entries.length;
		entries.push(entry);
		const path = file.name.slice(slash + 1);
		// Do not inflate ignored binaries or known oversized entries.
		if (file.name.endsWith("/") || !keep_path(path) || (file.originalSize !== undefined && file.originalSize > MAX_FILE_BYTES)) {
			completed.push({ index, path, content: null, bytes: 0 });
			return;
		}
		let chunks: Uint8Array[] = [];
		let byteSize = 0;
		let crc = 0xffffffff;
		let oversized = false;
		file.ondata = (error, chunk, final) => {
			if (error) throw new ArchiveError("invalid", "ZIP decompression failed");
			expandedBytes += chunk.length;
			if (expandedBytes > MAX_EXPANDED_BYTES) throw new ArchiveError("cap", "ZIP expands past the safety limit");
			byteSize += chunk.length;
			crc = update_crc(crc, chunk);
			if (!oversized && byteSize > MAX_FILE_BYTES) {
				oversized = true;
				bufferedBytes -= chunks.reduce((sum, item) => sum + item.length, 0);
				chunks = [];
			}
			if (!oversized) {
				chunks.push(chunk.slice());
				bufferedBytes += chunk.length;
				if (bufferedBytes > MAX_BUFFERED_BYTES) throw new ArchiveError("cap", "ZIP buffers exceed the safety limit");
			}
			if (!final) return;
			entry.actualSize = byteSize;
			entry.crc = (crc ^ 0xffffffff) >>> 0;
			let content: string | null = null;
			if (!oversized) {
				const bytes = new Uint8Array(byteSize);
				let offset = 0;
				for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
				try { content = decoder.decode(bytes); } catch { /* Invalid UTF-8 is binary. */ }
				if (content?.includes("\0") || content?.startsWith("version https://git-lfs.github.com/spec/v1")) content = null;
			}
			completed.push({ index, path, content, bytes: oversized ? 0 : byteSize });
			chunks = [];
		};
		file.start();
	});
	unzip.register(UnzipInflate);

	const flush = async () => {
		for (const entry of completed.splice(0)) {
			bufferedBytes -= entry.bytes;
			if (entry.content !== null) {
				copyFiles++;
				copyBytes += entry.bytes;
				if (copyFiles > MAX_COPY_FILES || copyBytes > MAX_COPY_BYTES)
					throw new ArchiveError("cap", "Repository exceeds the copy cap");
			}
			await consume(entry);
		}
	};
	const reader = body.getReader();
	let finished = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) throw new ArchiveError("invalid", "ZIP stream must contain bytes");
			compressedBytes += value.length;
			if (compressedBytes > MAX_COMPRESSED_BYTES) throw new ArchiveError("cap", "ZIP compressed size exceeds 12 MiB");
			if (value.length >= MAX_TAIL_BYTES) tail = value.slice(-MAX_TAIL_BYTES);
			else {
				const keep = Math.min(tail.length, MAX_TAIL_BYTES - value.length);
				const nextTail = new Uint8Array(keep + value.length);
				nextTail.set(tail.subarray(tail.length - keep));
				nextTail.set(value, keep);
				tail = nextTail;
			}
			// Small pushes also bound a highly compressed entry's expanded chunk.
			for (let offset = 0; offset < value.length; offset += 1024) {
				try { unzip.push(value.subarray(offset, offset + 1024), false); }
				catch (error) {
					if (error instanceof ArchiveError) throw error;
					throw new ArchiveError("invalid", "ZIP is malformed");
				}
				await flush();
			}
		}
		try { unzip.push(new Uint8Array(), true); }
		catch (error) {
			if (error instanceof ArchiveError) throw error;
			throw new ArchiveError("invalid", "ZIP ended before an entry finished");
		}
		await flush();
		check_directory(tail, compressedBytes, entries);
		finished = true;
		return { files: copyFiles, bytes: copyBytes, entries: entries.length };
	} finally {
		if (!finished) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
