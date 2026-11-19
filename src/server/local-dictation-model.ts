import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { RECOMMENDED_DICTATION_MODEL as model } from "../core/dictation.ts";
import { LocalDictationError } from "./local-dictation.ts";

export class DictationModelDownload {
	state = { active: false, bytes: 0, error: null as string | null };
	constructor(readonly directory = path.join(PATHS.data, "dictation-models"), private request: typeof fetch = fetch,
		private artifact: { filename: string; url: string; size: number; sha256: string } = model) {}
	get filename() { return path.join(this.directory, this.artifact.filename); }
	async installed(): Promise<boolean> { try { return (await stat(this.filename)).size === this.artifact.size; } catch { return false; } }
	async download(signal: AbortSignal): Promise<string> {
		if (this.state.active) throw new LocalDictationError("busy", "The recommended model is already downloading.", 409);
		this.state = { active: true, bytes: 0, error: null };
		const artifact = this.artifact;
		const temporary = path.join(this.directory, `.${artifact.filename}.${randomUUID()}.part`);
		try {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			const response = await this.request(artifact.url, { signal });
			if (!response.ok || !response.body) throw new Error("Model download failed. Check your connection and try again.");
			const hash = createHash("sha256");
			const file = await open(temporary, "wx", 0o600);
			const reader = response.body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read(); if (done) break;
					signal.throwIfAborted();
					this.state.bytes += value.byteLength;
					if (this.state.bytes > artifact.size) throw new Error("The downloaded model has an unexpected size.");
					hash.update(value); await file.writeFile(value);
				}
			} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
			if (this.state.bytes !== artifact.size || hash.digest("hex") !== artifact.sha256) throw new Error("Model verification failed. No model was installed. Try downloading again.");
			signal.throwIfAborted();
			await rename(temporary, this.filename);
			return this.filename;
		} catch (error) {
			this.state.error = error instanceof Error ? error.message : "Model download failed.";
			throw error;
		} finally { try { await rm(temporary, { force: true }); } finally { this.state.active = false; } }
	}
}
const globals = globalThis as typeof globalThis & { lhDictationDownload?: DictationModelDownload };
export const dictationModelDownload = globals.lhDictationDownload ??= new DictationModelDownload();
