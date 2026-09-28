import type { BonoboEnv, BonoboPluginHandler } from "bonobo-plugin-sdk";
import type { BonoboHttpApi } from "bonobo-plugin-sdk/http-api";
import { z } from "zod";

import { ArchiveError, read_archive } from "./archive.js";

const MOUNT_ID = "sources";
const MAX_HOST_JSON_BYTES = 512 * 1024;
const SHA = z.string().regex(/^[a-f0-9]{40}$/);
const KEY = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/).refine((value) => value !== "tmp");
const COUNT = z.number().int().nonnegative();
const STAGING_ID = z.string().min(1).max(128);
const CONFIGURATION = z.object({
	mount: z.object({ name: KEY }).strict(),
	schedule: z.object({ everyMinutes: z.number().int().min(15).max(10_080) }).strict(),
	repositories: z.array(z.object({
		owner: z.string().regex(/^[a-zA-Z0-9-]{1,39}$/),
		repo: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
		ref: z.string().min(1).max(255).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
		volumeKey: KEY.optional(),
	}).strict().transform((value) => ({ ...value, volumeKey: value.volumeKey ?? value.repo.toLowerCase() }))).max(32),
}).strict().superRefine((value, ctx) => {
	const keys = new Set<string>();
	for (const repo of value.repositories) {
		if (!KEY.safeParse(repo.volumeKey).success || keys.has(repo.volumeKey))
			ctx.addIssue({ code: "custom", message: "Repository keys must be valid and unique" });
		keys.add(repo.volumeKey);
	}
});

const CHANGED = z.array(z.object({ repoIndex: COUNT.max(31), commitSha: SHA }).strict()).max(32);
const PROGRESS = z.object({
	configurationHash: z.string().regex(/^[a-f0-9]{64}$/), nextRepo: COUNT.max(31), empty: CHANGED,
}).strict();
const STATE = z.discriminatedUnion("phase", [
	z.object({
		phase: z.literal("scan"), configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
		scanStart: COUNT.max(31), scanFrom: COUNT.max(32), changed: CHANGED, empty: CHANGED,
	}).strict(),
	z.object({
		phase: z.literal("copy"), configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
		scanStart: COUNT.max(31), scanFrom: COUNT.max(32), changed: CHANGED.min(1), empty: CHANGED,
		stagingId: STAGING_ID.optional(), nextEntry: COUNT.max(20_000).optional(),
	}).strict(),
]);
const EVENT = z.object({
	event: z.literal("schedule.interval.elapsed"),
	configuration: CONFIGURATION,
	source: z.null(),
	chain: z.object({ index: COUNT.max(19), rootRunId: z.string().min(1), state: z.unknown() }),
});

const VOLUMES = z.object({
	mounts: z.array(z.object({
		mountId: z.string(),
		volumes: z.array(z.object({
			volumeKey: KEY,
			deleting: z.boolean(),
			published: z.object({ revision: z.string().max(1024) }).nullable(),
			staging: z.object({ stagingId: STAGING_ID, revision: z.string().max(1024), expiresAt: COUNT }).nullable(),
		})).max(128),
	})).max(4),
});
const STAGED = z.object({ stagingId: STAGING_ID });
const WRITTEN = z.object({
	written: z.array(z.object({ path: z.string(), bytes: COUNT })).max(100),
	errors: z.array(z.object({ path: z.string(), errorCode: z.string(), message: z.string() })).max(100),
});
const PUBLISHED = z.object({ volumeKey: KEY, revision: z.string(), fileCount: COUNT, bytes: COUNT, publishedAt: COUNT });
const DELETED = z.object({ deleted: z.literal(true) });
const PROGRESS_READ = z.object({ document: z.object({ value: PROGRESS }).nullable() });
const PROGRESS_WRITTEN = z.object({ revision: COUNT.positive(), byteSize: COUNT });
const FOLLOWED_UP = z.object({ ok: z.literal(true) });
const FAILURE = z.object({ errorCode: z.string().max(128).optional() });

type Configuration = z.infer<typeof CONFIGURATION>;
type State = z.infer<typeof STATE>;
type HostPath = "/api/v1/volumes/list" | "/api/v1/volumes/stage" | "/api/v1/volumes/write-many" |
	"/api/v1/volumes/publish" | "/api/v1/volumes/delete" | "/api/v1/plugin-runs/follow-up" |
	"/api/v1/plugin-data/read" | "/api/v1/plugin-data/write";

class StopChain extends Error {}
class SkipRepo extends Error {}
class ContinueCopy extends Error {}

async function read_text(body: ReadableStream<unknown> | null, limit: number) {
	if (!body) throw new Error("Response body is missing");
	const reader = body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	let done = false;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) { done = true; break; }
			if (!(item.value instanceof Uint8Array)) throw new Error("Response must contain bytes");
			size += item.value.length;
			if (size > limit) throw new Error("Response is too large");
			parts.push(item.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const part of parts) { bytes.set(part, offset); offset += part.length; }
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} finally {
		if (!done) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function read_json(body: ReadableStream<unknown> | null, limit = 64_000) {
	const value: unknown = JSON.parse(await read_text(body, limit));
	return value;
}

async function configuration_hash(configuration: Configuration) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(configuration)));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Secret reads, host requests and outbound requests all share this call budget.
class Run {
	calls = 0;
	subrequests = 0;
	skippedFiles = 0;
	constructor(readonly env: BonoboEnv) {}
	room(reserved = 0) { return this.calls + reserved < 20 && this.subrequests + reserved < 25; }
	take() {
		if (!this.room()) throw new StopChain("run_budget");
		this.calls++;
		this.subrequests++;
	}
	async post<P extends HostPath, T>(path: P, body: BonoboHttpApi[P]["POST"]["body"], schema: z.ZodType<T>) {
		this.take();
		const response = await fetch(`${this.env.BONOBO.host.apiOrigin}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.env.BONOBO.host.token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			redirect: "manual",
		});
		const result = await read_json(response.body, MAX_HOST_JSON_BYTES);
		if (!response.ok) {
			const failure = FAILURE.parse(result);
			throw new StopChain(failure.errorCode ?? `host_http_${response.status}`);
		}
		return schema.parse(result);
	}
	async secret() {
		this.take();
		const token = await this.env.BONOBO.secrets.get("GITHUB_TOKEN");
		if (token !== null && (typeof token !== "string" || !token || /[\r\n]/.test(token)))
			throw new Error("GitHub token response is invalid");
		return token;
	}
	async follow_up(state: State) {
		STATE.parse(state);
		const serialized = JSON.stringify(state);
		if (new TextEncoder().encode(serialized).length > 16 * 1024) throw new Error("Follow-up state is too large");
		await this.post("/api/v1/plugin-runs/follow-up", { state: serialized }, FOLLOWED_UP);
	}
	async get(url: string, token: string | null, accept: string) {
		this.take();
		return await fetch(url, {
			headers: {
				Accept: accept, "User-Agent": "Bonobo-GitHub-Sources", "X-GitHub-Api-Version": "2026-03-10",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			redirect: "manual",
		});
	}
}

async function head_commit(run: Run, repo: Configuration["repositories"][number], token: string | null) {
	const response = await run.get(
		`https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(repo.ref)}`,
		token, "application/vnd.github.sha",
	);
	if (response.status === 429 || response.status === 403) throw new StopChain("github_rate_or_access");
	if (!response.ok || response.status !== 200) { await response.body?.cancel(); throw new SkipRepo("head_unavailable"); }
	return SHA.parse((await read_text(response.body, 256)).trim());
}

async function archive_response(run: Run, repo: Configuration["repositories"][number], commitSha: string, token: string | null) {
	let url = `https://codeload.github.com/${repo.owner}/${repo.repo}/zip/${commitSha}`;
	if (token) {
		const redirect = await run.get(
			`https://api.github.com/repos/${repo.owner}/${repo.repo}/zipball/${commitSha}`, token, "application/vnd.github+json",
		);
		await redirect.body?.cancel();
		if (redirect.status === 429 || redirect.status === 403) throw new StopChain("github_rate_or_access");
		if (redirect.status !== 302) throw new SkipRepo("archive_redirect_missing");
		const location = redirect.headers.get("Location");
		if (!location) throw new SkipRepo("archive_redirect_missing");
		const destination = new URL(location);
		if (destination.origin !== "https://codeload.github.com" || destination.username || destination.password || destination.hash)
			throw new SkipRepo("archive_redirect_refused");
		url = destination.href;
	}
	// The temporary codeload link needs no Authorization header.
	const response = await run.get(url, null, "application/zip");
	if (response.status === 429 || response.status === 403) throw new StopChain("github_rate_or_access");
	if (response.status !== 200 || !response.body) {
		await response.body?.cancel();
		throw new SkipRepo("archive_unavailable");
	}
	const length = response.headers.get("Content-Length");
	if (length && (!/^\d+$/.test(length) || Number(length) > 12 * 1024 * 1024)) {
		await response.body.cancel();
		throw new SkipRepo("archive_size_cap");
	}
	return response.body;
}

async function copy_repo(run: Run, configuration: Configuration, state: Extract<State, { phase: "copy" }>, token: string | null) {
	const changed = state.changed[0];
	const repo = configuration.repositories[changed.repoIndex];
	const listed = await run.post("/api/v1/volumes/list", { mountId: MOUNT_ID }, VOLUMES);
	const mount = listed.mounts.find((item) => item.mountId === MOUNT_ID);
	if (!mount) throw new Error("Source mount is missing");
	const volume = mount.volumes.find((item) => item.volumeKey === repo.volumeKey);
	if (volume?.deleting) throw new StopChain("volume_deleting");
	if (volume?.published?.revision === changed.commitSha) return "complete";
	const open = volume?.staging;
	const reusable = open && open.revision === changed.commitSha && open.expiresAt > Date.now() ? open : null;
	const staged = reusable ?? await run.post("/api/v1/volumes/stage", {
		mountId: MOUNT_ID, volumeKey: repo.volumeKey, revision: changed.commitSha,
	}, STAGED);
	// State never chooses a staging tree. The live list pins this repo and revision.
	const startFrom = reusable && state.stagingId === reusable.stagingId ? state.nextEntry ?? 0 : 0;
	let confirmedNext = startFrom;
	let batchEnd = startFrom;
	let batch: { path: string; content: string }[] = [];
	const byteSize = (files: typeof batch) => new TextEncoder().encode(JSON.stringify({ stagingId: staged.stagingId, files })).length;
	const flush = async () => {
		if (!batch.length) return;
		if (!run.room(2)) throw new ContinueCopy();
		const result = await run.post("/api/v1/volumes/write-many", { stagingId: staged.stagingId, files: batch }, WRITTEN);
		const pending = new Map(batch.map((file) => [file.path, new TextEncoder().encode(file.content).length]));
		for (const written of result.written) {
			if (pending.get(written.path) !== written.bytes) throw new Error("Host write receipt is invalid");
			pending.delete(written.path);
		}
		let cap = false;
		let stop: string | null = null;
		for (const error of result.errors) {
			if (!pending.has(error.path)) throw new Error("Host write receipt repeats or adds a path");
			pending.delete(error.path);
			if (["copy_cap_reached", "installation_cap_reached"].includes(error.errorCode)) cap = true;
			else if (["invalid_path", "invalid_content", "path_conflict"].includes(error.errorCode)) run.skippedFiles++;
			else stop = error.errorCode;
		}
		if (pending.size) throw new Error("Host write receipt omits a path");
		if (stop) throw new StopChain(stop);
		if (cap) throw new SkipRepo("copy_cap_reached");
		confirmedNext = batchEnd;
		batch = [];
	};
	try {
		const body = await archive_response(run, repo, changed.commitSha, token);
		const archive = await read_archive(body, async (entry) => {
			if (entry.index < startFrom) return;
			if (entry.content === null) {
				batchEnd = entry.index + 1;
				if (!batch.length) confirmedNext = batchEnd;
				return;
			}
			const file = { path: `/${entry.path}`, content: entry.content };
			if (batch.length === 100 || byteSize([...batch, file]) > 7_500_000) await flush();
			batch.push(file);
			batchEnd = entry.index + 1;
		});
		if (startFrom > archive.entries) throw new Error("Saved ZIP cursor is invalid");
		await flush();
		// Empty copies cannot publish. Hide old files only after the ZIP passes every check.
		if (archive.files === 0) {
			await run.post("/api/v1/volumes/delete", { mountId: MOUNT_ID, volumeKey: repo.volumeKey }, DELETED);
			state.empty = [...state.empty.filter((item) => item.repoIndex !== changed.repoIndex), changed];
			await run.post("/api/v1/plugin-data/write", {
				collection: "sync", key: "progress",
				value: { configurationHash: state.configurationHash, nextRepo: (state.scanStart + 1) % configuration.repositories.length, empty: state.empty },
			}, PROGRESS_WRITTEN);
			return "complete";
		}
		const published = await run.post("/api/v1/volumes/publish", { stagingId: staged.stagingId }, PUBLISHED);
		if (published.volumeKey !== repo.volumeKey || published.revision !== changed.commitSha)
			throw new Error("Host publication receipt is invalid");
		return "complete";
	} catch (error) {
		if (error instanceof ContinueCopy) {
			await run.follow_up({ ...state, stagingId: staged.stagingId, nextEntry: confirmedNext });
			return "continued";
		}
		throw error;
	}
}

export default {
	async fetch(request, env) {
		let parsed: z.infer<typeof EVENT>;
		try { parsed = EVENT.parse(await read_json(request.body)); }
		catch { return Response.json({ error: "Invalid schedule or repository settings" }, { status: 400 }); }
		const configuration = parsed.configuration;
		const hash = await configuration_hash(configuration);
		let state: State;
		try {
			if (parsed.chain.index === 0) {
				if (parsed.chain.state !== null) throw new Error("Root state must be null");
				state = { phase: "scan", configurationHash: hash, scanStart: 0, scanFrom: 0, changed: [], empty: [] };
			} else {
				state = STATE.parse(parsed.chain.state);
				if (state.configurationHash !== hash) return Response.json({ status: "paused", reason: "settings_changed" });
				const count = configuration.repositories.length;
				const position = (repoIndex: number) => (repoIndex - state.scanStart + count) % count;
				if (state.scanFrom > count || state.scanStart >= Math.max(count, 1) ||
					(state.phase === "copy" && state.scanFrom !== configuration.repositories.length) ||
					state.changed.some((item, index) => item.repoIndex >= count || position(item.repoIndex) >= state.scanFrom ||
						(index > 0 && position(item.repoIndex) <= position(state.changed[index - 1].repoIndex))) ||
					state.empty.some((item, index) => item.repoIndex >= count || state.empty.slice(0, index).some((previous) => previous.repoIndex === item.repoIndex)))
					throw new Error("Saved scan state is invalid");
			}
		} catch { return Response.json({ error: "Invalid saved sync state" }, { status: 400 }); }
		const run = new Run(env);
		try {
			const token = await run.secret();
			if (parsed.chain.index === 0) {
				const stored = await run.post("/api/v1/plugin-data/read", { collection: "sync", key: "progress" }, PROGRESS_READ);
				const progress = stored.document?.value;
				if (progress?.configurationHash === hash) {
					const count = configuration.repositories.length;
					if (progress.nextRepo >= Math.max(count, 1) || progress.empty.some((item, index) => item.repoIndex >= count ||
						progress.empty.slice(0, index).some((previous) => previous.repoIndex === item.repoIndex)))
						throw new Error("Saved sync progress is invalid");
					state.scanStart = progress.nextRepo;
					state.empty = progress.empty;
				}
				// Rotate before work so daily changes and early failures cannot always favor the first repos.
				await run.post("/api/v1/plugin-data/write", {
					collection: "sync", key: "progress",
					value: { configurationHash: hash, nextRepo: (state.scanStart + 1) % Math.max(configuration.repositories.length, 1), empty: state.empty },
				}, PROGRESS_WRITTEN);
			}
			if (state.phase === "scan") {
				const listed = await run.post("/api/v1/volumes/list", { mountId: MOUNT_ID }, VOLUMES);
				const mount = listed.mounts.find((item) => item.mountId === MOUNT_ID);
				if (!mount) throw new Error("Source mount is missing");
				const keys = new Set(configuration.repositories.map((repo) => repo.volumeKey));
				const removed = mount.volumes.filter((volume) => !keys.has(volume.volumeKey) && !volume.deleting);
				for (const volume of removed.slice(0, 5))
					await run.post("/api/v1/volumes/delete", { mountId: MOUNT_ID, volumeKey: volume.volumeKey }, DELETED);
				if (removed.length > 5) {
					await run.follow_up(state);
					return Response.json({ status: "continued", phase: "scan", calls: run.calls });
				}
				while (state.scanFrom < configuration.repositories.length && run.room(2)) {
					const repoIndex = (state.scanStart + state.scanFrom++) % configuration.repositories.length;
					const repo = configuration.repositories[repoIndex];
					try {
						const commitSha = await head_commit(run, repo, token);
						const volume = mount.volumes.find((item) => item.volumeKey === repo.volumeKey);
						const empty = !volume || volume.deleting ? state.empty.find((item) => item.repoIndex === repoIndex)?.commitSha : null;
						const published = volume?.deleting ? null : volume?.published?.revision;
						if (published !== commitSha && empty !== commitSha) state.changed.push({ repoIndex, commitSha });
					} catch (error) {
						if (!(error instanceof SkipRepo)) throw error;
					}
				}
				if (state.scanFrom < configuration.repositories.length) await run.follow_up(state);
				else if (state.changed.length) await run.follow_up({ ...state, phase: "copy" });
				else return Response.json({ status: "complete", calls: run.calls });
				return Response.json({ status: "continued", phase: "scan", calls: run.calls });
			}
			const changed = state.changed[0];
			let result: string;
			try { result = await copy_repo(run, configuration, state, token); }
			catch (error) {
				if (!(error instanceof SkipRepo) && !(error instanceof ArchiveError)) throw error;
				result = "skipped";
			}
			if (result === "continued") return Response.json({ status: "continued", phase: "copy", calls: run.calls, skippedFiles: run.skippedFiles });
			const remaining = state.changed.slice(1);
			if (remaining.length) await run.follow_up({ ...state, changed: remaining, stagingId: undefined, nextEntry: undefined });
			return Response.json({ status: remaining.length ? "continued" : "complete", repoIndex: changed.repoIndex, result, calls: run.calls, skippedFiles: run.skippedFiles });
		} catch (error) {
			if (error instanceof StopChain) return Response.json({ status: "paused", reason: error.message, calls: run.calls, skippedFiles: run.skippedFiles });
			return Response.json({ error: "GitHub sync failed", calls: run.calls }, { status: 500 });
		}
	},
} satisfies BonoboPluginHandler;
