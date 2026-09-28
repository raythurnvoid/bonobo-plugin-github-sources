import type { BonoboEnv } from "bonobo-plugin-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";

import worker from "./src/worker.js";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const NEXT_SHA = "c".repeat(40);
const STAGE_REQUEST = z.object({ mountId: z.literal("sources"), volumeKey: z.string(), revision: z.string() });
const WRITE_REQUEST = z.object({ stagingId: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })) });
type Files = z.infer<typeof WRITE_REQUEST>["files"];
type Volume = {
	volumeKey: string;
	deleting: boolean;
	published: { revision: string; files: Map<string, string> } | null;
	staging: { stagingId: string; revision: string; expiresAt: number; files: Map<string, string> } | null;
};

function configuration(count = 1) {
	return {
		mount: { name: "github" }, schedule: { everyMinutes: 1440 },
		repositories: Array.from({ length: count }, (_, index) => ({ owner: "example", repo: `repo${index}`, ref: "main", volumeKey: `repo${index}` })),
	};
}

class Host {
	configuration = configuration();
	volumes = new Map<string, Volume>();
	heads = new Map<string, string>();
	zips = new Map<string, Uint8Array>();
	requests: { url: string; authorization: string | null; redirect?: string; body: unknown }[] = [];
	callCounts: number[] = [];
	writeCosts: number[] = [];
	stages = 0;
	published: string[] = [];
	dailyLeft = 10_000;
	token: string | null = null;
	redirect = "";
	writeError: string | null = null;
	capRepo: string | null = null;
	capError = "copy_cap_reached";
	malformed = new Map<string, unknown>();
	statusFailures = new Map<string, number>();
	archiveHeaders: HeadersInit = {};
	writeReceipt: ((files: Files) => unknown) | null = null;
	progress: unknown = null;
	progressRevision = 0;
	lostAcknowledgements = new Set<string>();
	nextState: unknown = undefined;
	index = 0;
	currentCalls = 0;
	env: BonoboEnv = {
		BONOBO: {
			host: { apiOrigin: "https://press.test", token: "plr_test" },
			secrets: { get: () => { this.currentCalls++; return Promise.resolve(this.token); } },
		},
	};

	constructor(count = 1) {
		this.configuration = configuration(count);
		for (const repo of this.configuration.repositories) {
			this.heads.set(repo.repo, NEW_SHA);
			this.zips.set(repo.repo, zipSync({ "root/README.md": strToU8(`${repo.repo} text`) }));
		}
		vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
			this.currentCalls++;
			if (this.currentCalls > 20) throw new Error("Host call budget exceeded");
			const parsed = new URL(url);
			const raw: unknown = init?.body ? JSON.parse(z.string().parse(init.body)) : null;
			this.requests.push({ url, authorization: new Headers(init?.headers).get("Authorization"), redirect: init?.redirect, body: raw });
			const route = parsed.pathname;
			if (this.malformed.has(route)) return Response.json(this.malformed.get(route));
			const status = this.statusFailures.get(route);
			if (status) return Response.json({ errorCode: status === 409 ? "chain_limit" : "refused", message: "Refused" }, { status });
			if (parsed.hostname === "api.github.com") {
				const repo = route.split("/")[3];
				if (route.includes("/commits/")) return new Response(this.heads.get(repo));
				if (route.includes("/zipball/")) return new Response(null, {
					status: 302, headers: { Location: this.redirect || `https://codeload.github.com/example/${repo}/legacy.zip/${NEW_SHA}?temporary=link` },
				});
			}
			if (parsed.hostname === "codeload.github.com") {
				const repo = route.split("/")[2];
				const bytes = this.zips.get(repo);
				if (!bytes) return new Response(null, { status: 404 });
				// A small stream exercises chunk boundaries, not an arrayBuffer shortcut.
				let offset = 0;
				return new Response(new ReadableStream<Uint8Array>({
					pull(controller) {
						if (offset === bytes.length) { controller.close(); return; }
						controller.enqueue(bytes.slice(offset, offset + 311));
						offset = Math.min(bytes.length, offset + 311);
					},
				}), { headers: this.archiveHeaders });
			}
			if (route === "/api/v1/volumes/list") return Response.json({ mounts: [{ mountId: "sources", name: "github", volumes: [...this.volumes.values()] }], usage: {} });
			if (route === "/api/v1/plugin-data/read") {
				z.object({ collection: z.literal("sync"), key: z.literal("progress") }).parse(raw);
				return Response.json({ document: this.progress === null ? null : { value: this.progress } });
			}
			if (route === "/api/v1/plugin-data/write") {
				const body = z.object({ collection: z.literal("sync"), key: z.literal("progress"), value: z.record(z.string(), z.unknown()) }).parse(raw);
				this.progress = body.value;
				this.progressRevision++;
				if (this.lostAcknowledgements.delete(route)) throw new Error("Connection lost after saving progress");
				return Response.json({ revision: this.progressRevision, byteSize: new TextEncoder().encode(JSON.stringify(body.value)).length });
			}
			if (route === "/api/v1/volumes/stage") {
				const body = STAGE_REQUEST.parse(raw);
				this.stages++;
				const staging = { stagingId: `stage-${this.stages}`, revision: body.revision, expiresAt: Date.now() + 26 * 60 * 60_000, files: new Map<string, string>() };
				const previous = this.volumes.get(body.volumeKey);
				this.volumes.set(body.volumeKey, { volumeKey: body.volumeKey, deleting: false, published: previous?.published ?? null, staging });
				return Response.json({ stagingId: staging.stagingId, abandonedStagingId: previous?.staging?.stagingId ?? null });
			}
			if (route === "/api/v1/volumes/write-many") {
				const body = WRITE_REQUEST.parse(raw);
				if (this.writeReceipt) return Response.json(this.writeReceipt(body.files));
				const volume = [...this.volumes.values()].find((item) => item.staging?.stagingId === body.stagingId);
				if (!volume?.staging) throw new Error("Unknown staging tree");
				const written: { path: string; bytes: number }[] = [];
				const errors: { path: string; errorCode: string; message: string }[] = [];
				let cost = 0;
				for (const file of body.files) {
					const newFile = !volume.staging.files.has(file.path);
					const errorCode = this.capRepo === volume.volumeKey ? this.capError : this.writeError ?? (newFile && !this.dailyLeft ? "daily_cap_reached" : null);
					if (errorCode) { errors.push({ path: file.path, errorCode, message: "Refused" }); continue; }
					volume.staging.files.set(file.path, file.content);
					if (newFile) { this.dailyLeft--; cost++; }
					written.push({ path: file.path, bytes: new TextEncoder().encode(file.content).length });
				}
				this.writeCosts.push(cost);
				return Response.json({ written, errors });
			}
			if (route === "/api/v1/volumes/publish") {
				const body = z.object({ stagingId: z.string() }).parse(raw);
				const volume = [...this.volumes.values()].find((item) => item.staging?.stagingId === body.stagingId);
				if (!volume?.staging) throw new Error("Unknown staging tree");
				const staging = volume.staging;
				if (!staging.files.size) return Response.json({ message: "Cannot publish an empty copy", errorCode: "empty_copy" }, { status: 409 });
				volume.published = { revision: staging.revision, files: new Map(staging.files) };
				volume.staging = null;
				this.published.push(volume.volumeKey);
				return Response.json({ volumeKey: volume.volumeKey, revision: staging.revision, fileCount: staging.files.size, bytes: 0, publishedAt: Date.now() });
			}
			if (route === "/api/v1/volumes/delete") {
				const body = z.object({ mountId: z.literal("sources"), volumeKey: z.string() }).parse(raw);
				const volume = this.volumes.get(body.volumeKey);
				if (volume) volume.deleting = true;
				if (this.lostAcknowledgements.delete(route)) throw new Error("Connection lost after hiding the copy");
				return Response.json({ deleted: true });
			}
			if (route === "/api/v1/plugin-runs/follow-up") {
				if (this.index === 19) return Response.json({ message: "Limit", errorCode: "chain_limit" }, { status: 409 });
				const body = z.object({ state: z.string() }).parse(raw);
				expect(new TextEncoder().encode(body.state).length).toBeLessThanOrEqual(16 * 1024);
				this.nextState = JSON.parse(body.state);
				return Response.json({ ok: true });
			}
			throw new Error("Unexpected fetch route");
		});
	}

	async run(index = 0, state: unknown = null, settings: unknown = this.configuration) {
		this.index = index;
		this.currentCalls = 0;
		this.nextState = undefined;
		const response = await worker.fetch(new Request("https://plugin.local/", {
			method: "POST", body: JSON.stringify({ event: "schedule.interval.elapsed", configuration: settings, source: null, chain: { rootRunId: "root", index, state } }),
		}), this.env);
		this.callCounts.push(this.currentCalls);
		return response;
	}

	async chain() {
		let state: unknown = null;
		for (let index = 0; index < 20; index++) {
			const response = await this.run(index, state);
			expect(response.status).toBe(200);
			if (this.nextState === undefined) return response;
			state = this.nextState;
		}
		throw new Error("Chain did not stop");
	}
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("GitHub Sources scheduled worker", () => {
	test("scans all 32 repos and reaches changed repo 31 within one chain", async () => {
		const host = new Host(32);
		for (const repo of host.configuration.repositories.slice(0, 31)) host.volumes.set(repo.volumeKey, {
			volumeKey: repo.volumeKey, deleting: false, published: { revision: NEW_SHA, files: new Map() }, staging: null,
		});
		await host.chain();
		expect(host.requests.filter((request) => request.url.includes("/commits/")).length).toBe(32);
		expect(host.published).toEqual(["repo31"]);
		expect(host.callCounts.every((count) => count <= 20 && count <= 25)).toBe(true);
	});
	test("skips an unchanged copy", async () => {
		const host = new Host();
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: { revision: NEW_SHA, files: new Map() }, staging: null });
		await host.chain();
		expect(host.stages).toBe(0);
		expect(host.published).toEqual([]);
	});
	test("a 20-run chain stop leaves progress for the next root", async () => {
		const host = new Host(32);
		const response = await host.chain();
		expect(await response.json()).toMatchObject({ status: "paused", reason: "chain_limit" });
		expect(host.published.length).toBe(17);
		await host.chain();
		expect(host.published).toEqual(host.configuration.repositories.map((repo) => repo.volumeKey));
		expect(host.stages).toBe(32);
		expect(host.callCounts.every((count) => count <= 20 && count <= 25)).toBe(true);
	});
	test("writes absolute paths and publishes only the full accepted copy", async () => {
		const host = new Host();
		host.zips.set("repo0", zipSync({ "root/a.txt": strToU8("a"), "root/src/b.ts": strToU8("b"), "root/dist/a.js": strToU8("skip") }));
		await host.chain();
		expect([...host.volumes.get("repo0")!.published!.files]).toEqual([["/a.txt", "a"], ["/src/b.ts", "b"]]);
		expect(host.requests.filter((request) => request.url.startsWith("https://press.test")).every((request) => request.authorization === "Bearer plr_test")).toBe(true);
	});
	test.each(["ascii", "cjk"])("publishes 100 saved files after a valid long-path %s receipt", async (kind) => {
		const host = new Host();
		const folder = kind === "ascii" ? "f".repeat(200) : "清".repeat(255);
		const prefix = kind === "ascii" ? "f".repeat(90) : "清".repeat(248);
		const files = Array.from({ length: 100 }, (_, index) => ({
			path: `/${folder}/${folder}/${folder}/${prefix}${String(index).padStart(3, "0")}.txt`, content: "text",
		}));
		const receiptBytes = new TextEncoder().encode(JSON.stringify({ written: files.map((file) => ({ path: file.path, bytes: 4 })), errors: [] })).length;
		expect(receiptBytes).toBeGreaterThan(kind === "ascii" ? 64_000 : 256 * 1024);
		host.zips.set("repo0", zipSync(Object.fromEntries(files.map((file) => [`root${file.path}`, strToU8(file.content)]))));

		await host.run();
		const response = await host.run(1, host.nextState);

		expect(host.writeCosts).toEqual([100]);
		expect(host.published, "all 100 long-path files must publish after the valid receipt").toEqual(["repo0"]);
		expect(response.status).toBe(200);
		expect([...host.volumes.get("repo0")!.published!.files]).toEqual(files.map((file) => [file.path, file.content]));
	});
	test("refuses a host JSON body over 512 KiB", async () => {
		const host = new Host();
		host.malformed.set("/api/v1/volumes/list", { mounts: [{ mountId: "sources", volumes: [] }], padding: "x".repeat(512 * 1024) });

		const response = await host.run();

		expect(response.status).toBe(500);
		expect(host.stages).toBe(0);
		expect(host.published).toEqual([]);
	});
	test("keeps the 64 KB schedule body limit", async () => {
		const host = new Host();
		const response = await worker.fetch(new Request("https://plugin.local/", {
			method: "POST", body: JSON.stringify({
				event: "schedule.interval.elapsed", configuration: configuration(0), source: null,
				chain: { rootRunId: "root", index: 0, state: null }, padding: "x".repeat(64_000),
			}),
		}), host.env);

		expect(response.status).toBe(400);
		expect(host.currentCalls).toBe(0);
	});
	test("a validated filtered-only replacement hides old text and skips its saved empty revision", async () => {
		const host = new Host();
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: { revision: OLD_SHA, files: new Map([["/old.txt", "old"]]) }, staging: null });
		host.zips.set("repo0", zipSync({ "root/dist/bundle.js": strToU8("filtered"), "root/photo.png": new Uint8Array([0, 1]) }));

		await host.chain();

		expect(host.volumes.get("repo0")!.deleting, "a fully validated filtered-only replacement must hide the old text").toBe(true);
		expect(host.requests.some((request) => request.url.endsWith("/volumes/publish"))).toBe(false);
		expect(host.progress).toMatchObject({ empty: [{ repoIndex: 0, commitSha: NEW_SHA }] });
		const archiveCalls = host.requests.filter((request) => request.url.startsWith("https://codeload.github.com")).length;

		await host.chain();
		host.volumes.delete("repo0");
		await host.chain();

		expect(host.requests.filter((request) => request.url.startsWith("https://codeload.github.com")).length).toBe(archiveCalls);
		host.heads.set("repo0", NEXT_SHA);
		host.zips.set("repo0", zipSync({ "root/new.txt": strToU8("new") }));

		await host.chain();

		expect([...host.volumes.get("repo0")!.published!.files]).toEqual([["/new.txt", "new"]]);
	});
	test("an invalid filtered-only ZIP keeps the old text", async () => {
		const host = new Host();
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: { revision: OLD_SHA, files: new Map([["/old.txt", "old"]]) }, staging: null });
		const bytes = zipSync({ "root/dist/bundle.js": strToU8("filtered") });
		host.zips.set("repo0", bytes.slice(0, -22));

		await host.chain();

		expect(host.volumes.get("repo0")!.deleting).toBe(false);
		expect([...host.volumes.get("repo0")!.published!.files]).toEqual([["/old.txt", "old"]]);
		expect(host.progress).toMatchObject({ empty: [] });
	});
	test("a refused empty-copy delete keeps the old text and retries", async () => {
		const host = new Host();
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: { revision: OLD_SHA, files: new Map([["/old.txt", "old"]]) }, staging: null });
		host.zips.set("repo0", zipSync({ "root/photo.png": new Uint8Array([0]) }));
		host.statusFailures.set("/api/v1/volumes/delete", 409);

		await host.chain();

		expect(host.volumes.get("repo0")!.deleting).toBe(false);
		expect(host.progress).toMatchObject({ empty: [] });
		host.statusFailures.delete("/api/v1/volumes/delete");

		await host.chain();

		expect(host.stages).toBe(1);
		expect(host.volumes.get("repo0")!.deleting).toBe(true);
		expect(host.progress).toMatchObject({ empty: [{ repoIndex: 0, commitSha: NEW_SHA }] });
	});
	test("a lost empty-copy delete response uses the live deleting state before retry", async () => {
		const host = new Host();
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: { revision: OLD_SHA, files: new Map([["/old.txt", "old"]]) }, staging: null });
		host.zips.set("repo0", zipSync({ "root/photo.png": new Uint8Array([0]) }));
		host.lostAcknowledgements.add("/api/v1/volumes/delete");

		await host.run();
		const failed = await host.run(1, host.nextState);

		expect(failed.status).toBe(500);
		expect(host.volumes.get("repo0")!.deleting).toBe(true);
		expect(host.progress).toMatchObject({ empty: [] });
		const stages = host.stages;

		const waiting = await host.chain();

		expect(await waiting.json()).toMatchObject({ status: "paused", reason: "volume_deleting" });
		expect(host.stages).toBe(stages);
		host.volumes.delete("repo0");

		await host.chain();

		expect(host.progress).toMatchObject({ empty: [{ repoIndex: 0, commitSha: NEW_SHA }] });
		expect(host.published).toEqual([]);
	});
	test("a changed head waits for an empty-copy drain even when it matches the retired publication", async () => {
		const host = new Host();
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: { revision: OLD_SHA, files: new Map([["/old.txt", "old"]]) }, staging: null });
		host.zips.set("repo0", zipSync({ "root/photo.png": new Uint8Array([0]) }));
		await host.chain();
		host.heads.set("repo0", OLD_SHA);
		host.zips.set("repo0", zipSync({ "root/old.txt": strToU8("old") }));

		const waiting = await host.chain();

		expect(await waiting.json()).toMatchObject({ status: "paused", reason: "volume_deleting" });
		host.volumes.delete("repo0");

		await host.chain();

		expect(host.volumes.get("repo0")!.published!.revision).toBe(OLD_SHA);
	});
	test.each([false, true])("daily changing heads reach every repo with a large first repo: %s", async (largeFirst) => {
		const host = new Host(32);
		if (largeFirst) host.zips.set("repo0", zipSync({ "root/a.txt": strToU8("a"), "root/b.txt": strToU8("b") }));
		for (let day = 0; day < 32; day++) {
			host.dailyLeft = 1;
			for (const repo of host.configuration.repositories) host.heads.set(repo.repo, String(day + 1).padStart(40, "0"));
			await host.chain();
		}

		const attempted = new Set(host.requests.filter((request) => request.url.startsWith("https://codeload.github.com")).map((request) => new URL(request.url).pathname.split("/")[2]));
		expect(attempted.size, "changing daily heads must let every repo reach its archive request").toBe(32);
		expect(new Set(host.published).size).toBe(largeFirst ? 31 : 32);
		expect(host.published.includes("repo0")).toBe(!largeFirst);
		expect(host.callCounts.every((count) => count <= 20 && count <= 25)).toBe(true);
	});
	test("a lost KV write response keeps the saved fair cursor for the next root", async () => {
		const host = new Host(2);
		host.lostAcknowledgements.add("/api/v1/plugin-data/write");

		const failed = await host.run();

		expect(failed.status).toBe(500);
		expect(host.progress).toMatchObject({ nextRepo: 1 });
		expect(host.requests.some((request) => request.url.includes("/commits/"))).toBe(false);

		await host.chain();

		expect(host.published).toEqual(["repo1", "repo0"]);
	});
	test("a lost empty-revision KV reply still skips the hidden copy on the next root", async () => {
		const host = new Host();
		host.zips.set("repo0", zipSync({ "root/photo.png": new Uint8Array([0]) }));
		await host.run();
		host.lostAcknowledgements.add("/api/v1/plugin-data/write");

		const failed = await host.run(1, host.nextState);

		expect(failed.status).toBe(500);
		expect(host.progress).toMatchObject({ empty: [{ repoIndex: 0, commitSha: NEW_SHA }] });
		expect(host.volumes.get("repo0")!.deleting).toBe(true);
		const archiveCalls = host.requests.filter((request) => request.url.startsWith("https://codeload.github.com")).length;

		await host.chain();

		expect(host.requests.filter((request) => request.url.startsWith("https://codeload.github.com")).length).toBe(archiveCalls);
	});
	test.each(["read", "write"])("a refused KV %s stops before repo work", async (operation) => {
		const host = new Host();
		host.statusFailures.set(`/api/v1/plugin-data/${operation}`, 403);

		const response = await host.chain();

		expect(await response.json()).toMatchObject({ status: "paused", reason: "refused" });
		expect(host.requests.some((request) => request.url.includes("/commits/"))).toBe(false);
		expect(host.stages).toBe(0);
	});
	test("changed settings reset the saved cursor and empty revisions", async () => {
		const host = new Host(2);
		host.zips.set("repo0", zipSync({ "root/photo.png": new Uint8Array([0]) }));
		await host.chain();
		expect(host.progress).toMatchObject({ nextRepo: 1, empty: [{ repoIndex: 0, commitSha: NEW_SHA }] });
		host.volumes.delete("repo0");
		host.configuration.repositories[0].ref = "other";
		host.zips.set("repo0", zipSync({ "root/new.txt": strToU8("new") }));
		const previousHeads = host.requests.filter((request) => request.url.includes("/commits/")).length;

		await host.chain();

		expect(host.requests.filter((request) => request.url.includes("/commits/"))[previousHeads].url).toContain("/repo0/commits/other");
		expect(host.progress).toMatchObject({ empty: [] });
		expect([...host.volumes.get("repo0")!.published!.files]).toEqual([["/new.txt", "new"]]);
	});
	test.each([
		{ nextRepo: "1", empty: [] },
		{ nextRepo: 1, empty: [] },
		{ nextRepo: 0, empty: [{ repoIndex: 1, commitSha: NEW_SHA }] },
		{ nextRepo: 0, empty: [{ repoIndex: 0, commitSha: NEW_SHA }, { repoIndex: 0, commitSha: NEW_SHA }] },
	])("refuses malformed or out-of-range saved KV progress", async (patch) => {
		const host = new Host();
		await host.run();
		const saved = z.record(z.string(), z.unknown()).parse(host.progress);
		host.progress = { ...saved, ...patch };
		const previous = host.requests.length;

		const response = await host.run();

		expect(response.status).toBe(500);
		expect(host.requests.slice(previous).some((request) => request.url.includes("/commits/"))).toBe(false);
		expect(host.stages).toBe(0);
	});
	test("resumes the same staging tree and pinned commit across children", async () => {
		const host = new Host();
		host.zips.set("repo0", zipSync(Object.fromEntries(Array.from({ length: 1501 }, (_, index) => [`root/f${index}.txt`, strToU8("text")]))));
		await host.run();
		const scanState = host.nextState;
		host.heads.set("repo0", NEXT_SHA);
		await host.run(1, scanState);
		const copyState = host.nextState;
		expect(host.published).toEqual([]);
		expect(copyState).toMatchObject({ phase: "copy", stagingId: "stage-1" });
		await host.run(2, copyState);
		expect(host.stages, "a child must not retire the open copy by calling stage again").toBe(1);
		expect(host.volumes.get("repo0")!.published!.files.size).toBe(1501);
		expect(host.volumes.get("repo0")!.published!.revision).toBe(NEW_SHA);
		expect(host.requests.filter((request) => request.url.includes("/zip/")).every((request) => request.url.endsWith(NEW_SHA))).toBe(true);
		expect(host.callCounts.every((count) => count <= 20)).toBe(true);
	});
	test("continues a daily stop from list on the next root with free replacements", async () => {
		const host = new Host();
		host.zips.set("repo0", zipSync({ "root/a.txt": strToU8("a"), "root/b.txt": strToU8("b") }));
		host.dailyLeft = 1;
		const stopped = await host.chain();
		expect(await stopped.json()).toMatchObject({ status: "paused", reason: "daily_cap_reached" });
		expect(host.published, "daily refusal must keep the incomplete copy unpublished").toEqual([]);
		expect(host.stages).toBe(1);
		host.dailyLeft = 1;
		await host.chain();
		expect(host.stages, "the next root must reuse the list's matching staging id").toBe(1);
		expect(host.writeCosts).toEqual([1, 1]);
		expect(host.volumes.get("repo0")!.published!.files.size).toBe(2);
	});
	test.each(["storage_failure", "daily_cap_reached"])("stops %s without publication or follow-up", async (errorCode) => {
		const host = new Host();
		host.writeError = errorCode;
		const response = await host.chain();
		expect(await response.json()).toMatchObject({ status: "paused", reason: errorCode });
		expect(host.published).toEqual([]);
		expect(host.nextState).toBeUndefined();
	});
	test.each(["copy_cap_reached", "installation_cap_reached"])("repo A hitting %s does not block repo B", async (errorCode) => {
		const host = new Host(2);
		host.capRepo = "repo0";
		host.capError = errorCode;
		await host.chain();
		expect(host.published, "a cap on A must still let B publish").toEqual(["repo1"]);
		expect(host.volumes.get("repo0")!.staging).not.toBeNull();
	});
	test.each(["invalid_path", "invalid_content", "path_conflict"])("skips a refused %s item and completes the rest", async (errorCode) => {
		const host = new Host();
		host.zips.set("repo0", zipSync({ "root/a.txt": strToU8("a"), "root/b.txt": strToU8("b") }));
		host.writeReceipt = (files) => {
			host.volumes.get("repo0")!.staging!.files.set(files[1].path, files[1].content);
			return { written: [{ path: files[1].path, bytes: 1 }], errors: [{ path: files[0].path, errorCode, message: "Refused" }] };
		};
		const response = await host.chain();
		expect(await response.json()).toMatchObject({ skippedFiles: 1 });
		expect(host.published).toEqual(["repo0"]);
	});
	test("private ZIP follows only codeload and sends the token only to GitHub API", async () => {
		const host = new Host();
		host.token = "fake-test-token";
		await host.chain();
		const apiArchive = host.requests.find((request) => request.url.includes("/zipball/"));
		expect(apiArchive).toMatchObject({ authorization: "Bearer fake-test-token", redirect: "manual" });
		const codeload = host.requests.find((request) => request.url.startsWith("https://codeload.github.com"));
		expect(codeload).toMatchObject({ authorization: null, redirect: "manual" });
		expect(host.published).toEqual(["repo0"]);
	});
	test.each([
		"https://evil.test/archive.zip", "http://codeload.github.com/archive.zip", "https://codeload.github.com.evil.test/archive.zip",
		"https://user:pass@codeload.github.com/archive.zip", "https://codeload.github.com/archive.zip#secret",
	])("rejects a private ZIP redirect to %s", async (redirect) => {
		const host = new Host(); host.token = "fake-test-token"; host.redirect = redirect;
		await host.chain();
		expect(host.requests.filter((request) => request.url.includes("codeload")).length).toBe(0);
		expect(host.published).toEqual([]);
	});
	test("a truncated ZIP cannot publish an incomplete copy", async () => {
		const host = new Host();
		const bytes = host.zips.get("repo0")!;
		host.zips.set("repo0", bytes.slice(0, -22));
		await host.chain();
		expect(host.published, "a missing ZIP end must prevent publication").toEqual([]);
	});
	test("a broken ZIP after a saved batch keeps the old publication", async () => {
		const host = new Host();
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: { revision: OLD_SHA, files: new Map([["/old.txt", "old"]]) }, staging: null });
		const bytes = zipSync(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`root/f${index}.txt`, strToU8("text")])));
		host.zips.set("repo0", bytes.slice(0, -22));
		await host.chain();
		expect(host.volumes.get("repo0")!.staging!.files.size).toBe(100);
		expect(host.volumes.get("repo0")!.published!.revision).toBe(OLD_SHA);
		expect(host.published).toEqual([]);
	});
	test.each(["12582913", "-1", "invalid"])("refuses the archive Content-Length %s", async (length) => {
		const host = new Host(); host.archiveHeaders = { "Content-Length": length };
		await host.chain();
		expect(host.published).toEqual([]);
	});
	test("refuses a second redirect from codeload", async () => {
		const host = new Host(); host.token = "fake-test-token";
		host.statusFailures.set(`/example/repo0/legacy.zip/${NEW_SHA}`, 302);
		await host.chain();
		expect(host.requests.filter((request) => request.url.startsWith("https://codeload.github.com")).length).toBe(1);
		expect(host.published).toEqual([]);
	});
	test("the live list overrides a foreign staging id and cursor in saved state", async () => {
		const host = new Host(2);
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: null, staging: { stagingId: "owned", revision: NEW_SHA, expiresAt: Date.now() + 60_000, files: new Map() } });
		host.volumes.set("repo1", { volumeKey: "repo1", deleting: false, published: null, staging: { stagingId: "foreign", revision: NEXT_SHA, expiresAt: Date.now() + 60_000, files: new Map() } });
		await host.run();
		const state = z.record(z.string(), z.unknown()).parse(host.nextState);
		await host.run(1, { ...state, stagingId: "foreign", nextEntry: 999 });
		expect(host.stages).toBe(0);
		expect(host.published).toEqual(["repo0"]);
		expect(host.volumes.get("repo0")!.published!.files.size).toBe(1);
		expect(host.volumes.get("repo1")!.staging!.files.size).toBe(0);
		expect(WRITE_REQUEST.parse(host.requests.find((request) => request.url.endsWith("/write-many"))!.body).stagingId).toBe("owned");
	});
	test("an expired matching staging tree is replaced", async () => {
		const host = new Host();
		host.volumes.set("repo0", { volumeKey: "repo0", deleting: false, published: null, staging: { stagingId: "expired", revision: NEW_SHA, expiresAt: Date.now() - 1, files: new Map() } });
		await host.chain();
		expect(host.stages).toBe(1);
		expect(host.published).toEqual(["repo0"]);
	});
	test("valid JSON settings cannot make an invalid head response usable", async () => {
		const host = new Host(); host.heads.set("repo0", "not-a-sha");
		const response = await host.run();
		expect(response.status).toBe(500);
		expect(host.nextState).toBeUndefined();
		expect(host.stages).toBe(0);
	});
	test("batches escaped text below the actual JSON body limit", async () => {
		const host = new Host();
		host.zips.set("repo0", zipSync(Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`root/f${index}.txt`, strToU8("\t".repeat(800_000))]))));
		await host.chain();
		const writes = host.requests.filter((request) => request.url.endsWith("/write-many"));
		expect(writes.length).toBe(3);
		expect(writes.every((request) => new TextEncoder().encode(JSON.stringify(request.body)).length <= 7_500_000)).toBe(true);
		expect(host.volumes.get("repo0")!.published!.files.size).toBe(10);
	});
	test("a stopped root leaves earlier published repos and resumes the remaining one", async () => {
		const host = new Host(2);
		await host.run();
		const state = host.nextState;
		await host.run(1, state);
		const next = host.nextState;
		host.writeError = "storage_failure";
		await host.run(2, next);
		expect(host.published).toEqual(["repo0"]);
		host.writeError = null;
		await host.chain();
		expect(host.published).toEqual(["repo0", "repo1"]);
	});
	test.each([402, 429, 409])("stops a host HTTP %i answer", async (status) => {
		const host = new Host(); host.statusFailures.set("/api/v1/volumes/list", status);
		const response = await host.chain();
		expect(await response.json()).toMatchObject({ status: "paused" });
		expect(host.published).toEqual([]);
	});
	test("deletes no more than five removed keys per run", async () => {
		const host = new Host();
		for (let index = 0; index < 7; index++) host.volumes.set(`old${index}`, { volumeKey: `old${index}`, deleting: false, published: { revision: OLD_SHA, files: new Map() }, staging: null });
		await host.run();
		expect(host.requests.filter((request) => request.url.endsWith("/volumes/delete")).length).toBe(5);
		await host.run(1, host.nextState);
		expect(host.requests.filter((request) => request.url.endsWith("/volumes/delete")).length).toBe(7);
	});
	test.each([
		{ ...configuration(), repositories: configuration(33).repositories },
		{ ...configuration(), repositories: [{ owner: "../bad", repo: "good", ref: "main" }] },
		{ ...configuration(), repositories: [{ owner: "good", repo: "bad/repo", ref: "main" }] },
		{ ...configuration(), repositories: [{ owner: "good", repo: "good", ref: "main", volumeKey: "tmp" }] },
		{ ...configuration(), repositories: [{ owner: "good", repo: "A", ref: "main" }, { owner: "good", repo: "a", ref: "main" }] },
		{ ...configuration(), schedule: { everyMinutes: "1440" } },
	])("rejects invalid settings before any host call", async (settings) => {
		const host = new Host();

		const response = await host.run(0, null, settings);

		expect(response.status).toBe(400);
		expect(host.currentCalls).toBe(0);
	});
	test.each([null, {}, { phase: "copy", scanFrom: -1 }, { phase: "unknown" }])("rejects invalid child state", async (state) => {
		const host = new Host();

		const response = await host.run(1, state);

		expect(response.status).toBe(400);
		expect(host.currentCalls).toBe(0);
	});
	test("changed settings stop an old chain without using its repo indexes", async () => {
		const host = new Host();
		await host.run();
		const state = host.nextState;
		host.configuration.repositories[0].repo = "different";

		const response = await host.run(1, state);

		expect(await response.json()).toMatchObject({ status: "paused", reason: "settings_changed" });
		expect(host.currentCalls).toBe(0);
	});
	test.each([
		{ scanFrom: 1 },
		{ changed: [{ repoIndex: 2, commitSha: NEW_SHA }] },
		{ changed: [{ repoIndex: 0, commitSha: NEW_SHA }, { repoIndex: 0, commitSha: NEW_SHA }] },
		{ changed: [{ repoIndex: 1, commitSha: NEW_SHA }, { repoIndex: 0, commitSha: NEW_SHA }] },
	])("rejects valid-shaped child state with bad repo bounds", async (patch) => {
		const host = new Host(2);
		await host.run();
		const state = z.record(z.string(), z.unknown()).parse(host.nextState);

		const response = await host.run(1, { ...state, ...patch });

		expect(response.status).toBe(400);
		expect(host.currentCalls).toBe(0);
	});
	test.each([
		["/api/v1/volumes/list", { mounts: [{ mountId: "sources", volumes: [{ volumeKey: "repo0", deleting: "false" }] }] }],
		["/api/v1/volumes/stage", { stagingId: 123 }],
		["/api/v1/volumes/write-many", { written: [], errors: [] }],
	])("refuses malformed host data at %s", async (route, payload) => {
		const host = new Host();
		host.malformed.set(z.string().parse(route), payload);

		await host.run();
		if (host.nextState !== undefined) await host.run(1, host.nextState);

		expect(host.published).toEqual([]);
	});
	test.each(["foreign_path", "wrong_bytes", "duplicate_path"])("refuses a host write receipt with %s", async (problem) => {
		const host = new Host();
		host.writeReceipt = (files) => ({
			written: problem === "duplicate_path"
				? [{ path: files[0].path, bytes: 10 }, { path: files[0].path, bytes: 10 }]
				: [{ path: problem === "foreign_path" ? "/other.txt" : files[0].path, bytes: problem === "wrong_bytes" ? 99 : 10 }],
			errors: [],
		});
		await host.run();
		const response = await host.run(1, host.nextState);
		expect(response.status).toBe(500);
		expect(host.published).toEqual([]);
	});
});
