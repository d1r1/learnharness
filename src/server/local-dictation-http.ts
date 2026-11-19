import { desktopAPIAuthorized } from "./desktop-access.ts";
import { MAX_LOCAL_AUDIO_BYTES } from "../core/dictation.ts";
import { LocalDictationError, isLocalDictationError, localDictationSupported } from "./local-dictation.ts";

/** Local-only native capability, also safe in browser-only development (no CORS). */
export function assertLocalDictationRequest(request: Request) {
	const internal = new URL(request.url);
	// Next standalone normalizes request.url to localhost; Host retains the window's origin.
	let url: URL;
	try { url = new URL(`${internal.protocol}//${request.headers.get("host") ?? internal.host}`); }
	catch { throw new LocalDictationError("forbidden", "Invalid local request origin.", 403); }
	if (!desktopAPIAuthorized(request.headers) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		(request.headers.has("origin") && request.headers.get("origin") !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
		throw new LocalDictationError("forbidden", "Local dictation requires the trusted local LearnHarness window.", 403);
	}
}
export function assertLocalDictationSupported() {
	if (!localDictationSupported()) throw new LocalDictationError("unsupported_platform", "Local dictation currently requires macOS on Apple Silicon.", 503);
}
export function localDictationFailure(error: unknown): Response {
	if (error instanceof DOMException && error.name === "AbortError") return Response.json({ code: "canceled", message: "Dictation canceled." }, { status: 499, headers: { "Cache-Control": "no-store" } });
	const e = isLocalDictationError(error) ? error : new LocalDictationError("local_dictation_failed", "Local dictation failed. Try again.");
	return Response.json({ code: e.code, message: e.message }, { status: e.status, headers: { "Cache-Control": "no-store" } });
}
export async function readLocalAudio(request: Request, signal = request.signal): Promise<Buffer> {
	if (request.headers.get("content-type") !== "application/octet-stream") throw new LocalDictationError("unsupported_audio", "Expected PCM16 audio.", 415);
	if (Number(request.headers.get("content-length")) > MAX_LOCAL_AUDIO_BYTES) throw new LocalDictationError("audio_too_large", "Recording exceeds the 32 MiB local audio limit.", 413);
	const reader = request.body?.getReader();
	if (!reader) throw new LocalDictationError("invalid_audio", "Recording is empty.", 400);
	const chunks: Uint8Array[] = []; let size = 0;
	const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			signal.throwIfAborted(); size += value.length;
			if (size > MAX_LOCAL_AUDIO_BYTES) throw new LocalDictationError("audio_too_large", "Recording exceeds the 32 MiB local audio limit.", 413);
			chunks.push(value);
		}
		signal.throwIfAborted();
	} finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
	return Buffer.concat(chunks, size);
}
