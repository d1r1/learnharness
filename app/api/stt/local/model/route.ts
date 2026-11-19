import { dictationModelDownload, LocalDictationError, isLocalDictationError, assertLocalDictationRequest, assertLocalDictationSupported, localDictationFailure } from "@/src/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
	try {
		assertLocalDictationRequest(request); assertLocalDictationSupported();
		try {
			const modelPath = await dictationModelDownload.download(request.signal);
			return Response.json({ modelPath }, { headers: { "Cache-Control": "no-store" } });
		} catch (error) {
			if (isLocalDictationError(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
			throw new LocalDictationError("download_failed", dictationModelDownload.state.error ?? "Model download failed.", 502);
		}
	} catch (error) { return localDictationFailure(error); }
}
