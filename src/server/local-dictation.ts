import { spawn, type ChildProcess } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_LOCAL_AUDIO_BYTES, type ModelUnloadAfter } from "../core/dictation.ts";

export const localDictationSupported = () => process.platform === "darwin" && process.arch === "arm64";
export class LocalDictationError extends Error {
	constructor(public code: string, message: string, public status = 500) { super(message); this.name = "LocalDictationError"; }
}
// Instances can survive a dev-module reload through the process-wide engine/download cache.
export function isLocalDictationError(error: unknown): error is LocalDictationError {
	return error instanceof Error && error.name === "LocalDictationError" && "code" in error && typeof error.code === "string" && "status" in error && typeof error.status === "number";
}

export async function localModelPath(filename: string): Promise<string> {
	if (!filename || !path.isAbsolute(filename) || !filename.toLowerCase().endsWith(".gguf")) throw new LocalDictationError("model_required", "Choose a local GGUF model in Settings → Providers → Dictation.", 422);
	try {
		const resolved = await realpath(filename);
		if (!(await stat(resolved)).isFile()) throw new Error();
		const file = await open(resolved, "r");
		try {
			const magic = Buffer.alloc(4);
			await file.read(magic, 0, 4, 0);
			if (magic.toString() !== "GGUF") throw new Error();
		} finally { await file.close(); }
		return resolved;
	} catch { throw new LocalDictationError("invalid_model", "The selected model is missing, unreadable, or not a GGUF file.", 422); }
}

function launchWorker(): ChildProcess {
	return spawn(process.execPath, [path.join(process.cwd(), "src/server/local-dictation-worker.mjs")], {
		serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
}

/** One native process per app server. The child isolates native crashes and owns the model. */
export class LocalDictationEngine {
	private child: ChildProcess | null = null;
	private idle: ReturnType<typeof setTimeout> | undefined;
	private retiring: Promise<void> | null = null;
	private sequence = 0;
	private unloadAfter: ModelUnloadAfter = "never";
	private idleSince = 0;
	busy = false;
	loaded = false;
	loadedPath: string | null = null;
	constructor(private launch: () => ChildProcess = launchWorker) {}

	configure(unloadAfter: ModelUnloadAfter) {
		this.unloadAfter = unloadAfter; clearTimeout(this.idle);
		if (this.busy || !this.loaded || unloadAfter === "never") return;
		const timeout = unloadAfter === "5m" ? 300_000 : 3_600_000;
		this.idle = setTimeout(() => { void this.dispose(); }, Math.max(0, timeout - (Date.now() - this.idleSince)));
		this.idle.unref();
	}

	async dispose(): Promise<void> {
		if (this.retiring) return this.retiring;
		clearTimeout(this.idle);
		const child = this.child; this.child = null; this.loaded = false; this.loadedPath = null;
		if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
		this.retiring = new Promise<void>(resolve => {
			const force = setTimeout(() => child.kill("SIGKILL"), 1000); force.unref();
			child.once("exit", () => { clearTimeout(force); resolve(); });
			child.kill();
		});
		try { await this.retiring; } finally { this.retiring = null; }
	}

	async transcribe(readAudio: (signal: AbortSignal) => Promise<Buffer>, filename: string, unloadAfter: ModelUnloadAfter, externalSignal: AbortSignal): Promise<string> {
		const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(120_000)]);
		if (this.busy) throw new LocalDictationError("busy", "Local dictation is already processing another recording.", 409);
		this.busy = true; this.configure(unloadAfter);
		try {
			await this.retiring;
			signal.throwIfAborted();
			const file = await localModelPath(filename);
			const pcm = await readAudio(signal);
			if (!pcm.length || pcm.length % 2 || pcm.length > MAX_LOCAL_AUDIO_BYTES) throw new LocalDictationError("invalid_audio", "Expected nonempty 16 kHz mono PCM16 audio, up to 32 MiB.", 400);
			signal.throwIfAborted();
			if (!this.child) {
				const started = this.launch(); this.child = started;
				started.once("exit", () => { if (this.child === started) { this.child = null; this.loaded = false; this.loadedPath = null; } });
			}
			const child = this.child;
			const id = ++this.sequence;
			const text = await new Promise<string>((resolve, reject) => {
				const cleanup = () => { clearTimeout(deadline); signal.removeEventListener("abort", aborted); child.removeListener("message", message); child.removeListener("error", failed); child.removeListener("exit", exited); };
				const fail = (error: Error) => { cleanup(); reject(error); };
				const aborted = () => fail(new DOMException("Dictation canceled", "AbortError"));
				const failed = () => fail(new LocalDictationError("engine_failed", "The local speech engine could not start. Try again."));
				const exited = () => fail(new LocalDictationError("engine_failed", "The local speech engine stopped unexpectedly. Try again."));
				const message = (value: unknown) => {
					const result = value as { id?: unknown; text?: unknown; error?: unknown } | null;
					if (!result || result.id !== id) return;
					if (typeof result.error === "string") { fail(new LocalDictationError("recognition_failed", result.error)); return; }
					if (typeof result.text !== "string" || result.text.length > 2 * 1024 * 1024) { failed(); return; }
					cleanup(); resolve(result.text);
				};
				const deadline = setTimeout(() => fail(new LocalDictationError("timeout", "Local recognition timed out. Try a shorter recording.", 504)), 120_000);
				signal.addEventListener("abort", aborted, { once: true });
				child.on("message", message); child.once("error", failed); child.once("exit", exited);
				child.send({ id, path: file, pcm }, error => { if (error) failed(); });
			});
			this.loaded = true; this.loadedPath = file;
			return text;
		} catch (error) {
			await this.dispose();
			if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") throw new LocalDictationError("timeout", "Local recognition timed out. Try a shorter recording.", 504);
			throw error;
		} finally {
			this.busy = false; this.idleSince = Date.now();
			this.configure(this.unloadAfter);
		}
	}
}

const globalEngine = globalThis as typeof globalThis & { lhLocalDictation?: LocalDictationEngine };
export const localDictation = globalEngine.lhLocalDictation ??= new LocalDictationEngine();
