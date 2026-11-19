import {
	effectiveSettings, localDictation, localDictationSupported, localModelPath, dictationModelDownload,
	assertLocalDictationRequest, assertLocalDictationSupported, localDictationFailure, readLocalAudio,
} from "@/src/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
	try {
		assertLocalDictationRequest(request);
		let modelPath: string | null = null;
		try { modelPath = await localModelPath(effectiveSettings().dictation.modelPath); } catch { /* Report availability without loading native code. */ }
		return Response.json({ supported: localDictationSupported(), modelAvailable: modelPath !== null, loaded: localDictation.loaded && localDictation.loadedPath === modelPath, busy: localDictation.busy,
			download: dictationModelDownload.state, recommendedInstalled: await dictationModelDownload.installed(), recommendedPath: dictationModelDownload.filename,
		}, { headers: { "Cache-Control": "no-store" } });
	} catch (error) { return localDictationFailure(error); }
}

export async function POST(request: Request) {
	try {
		assertLocalDictationRequest(request); assertLocalDictationSupported();
		const settings = effectiveSettings().dictation;
		if (settings.provider !== "local") return Response.json({ code: "provider_changed", message: "Local dictation is no longer selected." }, { status: 409 });
		const text = await localDictation.transcribe(signal => readLocalAudio(request, signal), settings.modelPath, settings.unloadAfter, request.signal);
		return Response.json({ text }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) { return localDictationFailure(error); }
}
