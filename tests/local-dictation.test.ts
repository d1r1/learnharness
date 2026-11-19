import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalDictationEngine, localModelPath } from "../src/server/local-dictation.ts";
import { DictationModelDownload } from "../src/server/local-dictation-model.ts";
import { assertLocalDictationRequest, readLocalAudio } from "../src/server/local-dictation-http.ts";
import { MAX_LOCAL_AUDIO_BYTES } from "../src/core/dictation.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-local-stt-"));
	const model = path.join(directory, "model.gguf");
	await writeFile(model, "GGUFfixture");
	let launches = 0;
	const engine = new LocalDictationEngine(() => {
		launches++;
		return fork(new URL("./helpers/local-dictation-worker.mjs", import.meta.url), [], { execArgv: [], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
	});
	t.after(async () => { await engine.dispose(); await rm(directory, { recursive: true, force: true }); });
	return { directory, model, engine, get launches() { return launches; } };
}
const pcm = () => Promise.resolve(Buffer.from([1, 0, 2, 0]));
const signal = () => new AbortController().signal;

test("one process handles repeated recordings; concurrent audio is rejected before reading", async t => {
	const f = await fixture(t);
	const first = await f.engine.transcribe(pcm, f.model, "never", signal());
	assert.equal(await f.engine.transcribe(pcm, f.model, "never", signal()), first);
	assert.equal(f.launches, 1); assert.equal(f.engine.loaded, true);
	const controller = new AbortController();
	const pending = f.engine.transcribe(async () => Buffer.from([7, 0]), f.model, "never", controller.signal);
	await assert.rejects(f.engine.transcribe(() => { throw new Error("must not read"); }, f.model, "never", signal()), { code: "busy" });
	controller.abort(); await assert.rejects(pending, { name: "AbortError" });
	assert.equal(f.engine.busy, false); assert.equal(f.engine.loaded, false);
	await f.engine.transcribe(pcm, f.model, "never", signal()); assert.equal(f.launches, 2);
});

test("a failed spawn releases admission even though no exit event will arrive", async t => {
	const f = await fixture(t);
	const engine = new LocalDictationEngine(() => spawn("/definitely-missing-local-speech-helper", [], { stdio: ["ignore", "ignore", "ignore", "ipc"] }));
	await assert.rejects(engine.transcribe(pcm, f.model, "never", signal()), { code: "engine_failed" });
	assert.equal(engine.busy, false); await engine.dispose();
});

test("native process crash releases the slot and the next request starts cleanly", async t => {
	const f = await fixture(t);
	await assert.rejects(f.engine.transcribe(async () => Buffer.from([9, 0]), f.model, "never", signal()), { code: "engine_failed" });
	assert.equal(f.engine.busy, false); assert.equal(f.engine.loaded, false);
	assert.match(await f.engine.transcribe(pcm, f.model, "never", signal()), /^fixture:/);
	assert.equal(f.launches, 2);
});

for (const timeout of ["5m", "1h", "never"] as const) test(`model unload policy: ${timeout}`, async t => {
	const f = await fixture(t);
	await f.engine.transcribe(pcm, f.model, "never", signal());
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	f.engine.configure(timeout);
	t.mock.timers.tick(timeout === "5m" ? 300_000 : 3_600_000);
	assert.equal(f.engine.loaded, timeout === "never");
	// Restore real timers before awaiting child shutdown.
	t.mock.timers.reset();
});

test("local model and settings validation reject nonmodels without loading a process", async t => {
	const f = await fixture(t);
	await assert.rejects(localModelPath("relative.gguf"), { code: "model_required" });
	await writeFile(f.model, "not a GGUF");
	await assert.rejects(f.engine.transcribe(pcm, f.model, "never", signal()), { code: "invalid_model" });
	assert.equal(f.launches, 0);
	const preferences = { language: "ru", provider: "local", modelPath: f.model, unloadAfter: "never" };
	assert.deepEqual(parseDictationSettingsBody(preferences), { ok: true, settings: preferences });
	assert.deepEqual(resolveSettings(sanitizeUserSettings({ version: 1, dictation: preferences })).dictation, preferences);
	assert.equal(resolveSettings(null).dictation.provider, "deepgram");
	assert.equal(resolveSettings(null).dictation.unloadAfter, "never");
	for (const bad of [{ provider: "remote" }, { unloadAfter: "2h" }, { modelPath: "../../secret" }, { modelPath: "/tmp/not-a-model.txt" }]) assert.equal(parseDictationSettingsBody(bad).ok, false);
});

test("PCM upload bounds actual bytes, handles chunking and rejects cross-origin/native requests", async () => {
	const request = (headers: Record<string, string> = {}, body: BodyInit = new Uint8Array([1, 0, 2, 0])) => new Request("http://127.0.0.1:3000/api/stt/local", { method: "POST", headers: { "Content-Type": "application/octet-stream", ...headers }, body });
	assert.deepEqual(await readLocalAudio(request()), Buffer.from([1, 0, 2, 0]));
	await assert.rejects(readLocalAudio(request({ "Content-Length": String(MAX_LOCAL_AUDIO_BYTES + 1) })), { status: 413 });
	assert.throws(() => assertLocalDictationRequest(request({ Origin: "https://attacker.example" })), { status: 403 });
	assert.throws(() => assertLocalDictationRequest(new Request("http://attacker.example/api/stt/local")), { status: 403 });
	assert.throws(() => assertLocalDictationRequest(request({ "Sec-Fetch-Site": "cross-site" })), { status: 403 });
	assertLocalDictationRequest(request({ Origin: "http://127.0.0.1:3000" }));
	assertLocalDictationRequest(new Request("http://localhost:3000/api/stt/local", { headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" } }));
	assert.throws(() => assertLocalDictationRequest(request({ Host: "attacker.example" })), { status: 403 });
	const controller = new AbortController();
	const stream = new ReadableStream<Uint8Array>({});
	const pending = readLocalAudio(new Request("http://localhost/api/stt/local", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: stream, duplex: "half" } as RequestInit), controller.signal);
	controller.abort(); await assert.rejects(pending);
});

test("recommended download is checksum-verified and atomically installed; failures preserve the old model", async t => {
	const f = await fixture(t);
	const bytes = Buffer.from("GGUFsynthetic downloaded model");
	const artifact = { filename: "download.gguf", url: "https://example.invalid/pinned", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
	const download = new DictationModelDownload(f.directory, async url => { assert.equal(url, artifact.url); return new Response(bytes); }, artifact);
	assert.equal(await download.installed(), false);
	assert.equal(await download.download(signal()), path.join(f.directory, artifact.filename));
	assert.equal(await download.installed(), true); assert.deepEqual(await readFile(download.filename), bytes);
	for (const bad of [Buffer.from("corrupt"), Buffer.alloc(bytes.length + 1)]) {
		const failed = new DictationModelDownload(f.directory, async () => new Response(bad), artifact);
		await assert.rejects(failed.download(signal()));
		assert.deepEqual(await readFile(download.filename), bytes);
		assert.equal((await readdir(f.directory)).some(name => name.endsWith(".part")), false);
	}
});
