"use client";

import { useEffect, useRef, useState } from "react";
import { MODEL_UNLOAD_OPTIONS, RECOMMENDED_DICTATION_MODEL, type DictationProvider, type ModelUnloadAfter } from "@/src/core";
import { useDictationLanguage } from "./dictation-preference";
import { useDictationActive } from "./dictation-state";
import { SettingsRow, ThinSelect } from "./settings/controls";
import { Button } from "./ui/button";

type LocalStatus = { supported: boolean; modelAvailable: boolean; loaded: boolean; busy: boolean; recommendedInstalled: boolean; recommendedPath: string; download: { active: boolean; bytes: number; error: string | null } };

export function LocalDictationSettings() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	const [status, setStatus] = useState<LocalStatus | null>(null);
	const [working, setWorking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(false);
	const provider = preference.settings?.provider ?? "deepgram";
	const modelPath = preference.settings?.modelPath ?? "";
	const disabled = active || preference.saving || working || !!status?.download.active || preference.language === undefined;
	const refresh = async () => {
		const response = await fetch("/api/stt/local");
		const body = await response.json();
		if (!response.ok || typeof body.supported !== "boolean" || typeof body.modelAvailable !== "boolean" || !body.download || typeof body.download.active !== "boolean") throw new Error(body.message ?? "Could not check local dictation.");
		if (mounted.current) setStatus(body);
	};
	useEffect(() => {
		mounted.current = true;
		void refresh().catch(() => {});
		return () => { mounted.current = false; };
	}, []);
	useEffect(() => {
		if (provider !== "local") return;
		void refresh().catch(() => {});
		const timer = setInterval(() => { void refresh().catch(() => {}); }, 1500);
		return () => clearInterval(timer);
	}, [provider, modelPath]);

	const choose = async () => {
		setError(null);
		try {
			if (!window.lh?.chooseDictationModel) throw new Error("Choose model file requires the LearnHarness desktop app.");
			const filename = await window.lh.chooseDictationModel();
			if (filename && mounted.current) { await preference.saveSettings({ modelPath: filename }); await refresh(); }
		} catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Could not choose model."); }
	};
	const download = async () => {
		setWorking(true); setError(null);
		try {
			let filename = status?.recommendedPath;
			if (!status?.recommendedInstalled) {
				const response = await fetch("/api/stt/local/model", { method: "POST" });
				const body = await response.json();
				if (!response.ok) throw new Error(body.message ?? "Model download failed.");
				filename = body.modelPath;
			}
			if (filename && mounted.current) { await preference.saveSettings({ modelPath: filename }); await refresh(); }
		} catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Model download failed."); }
		finally { if (mounted.current) setWorking(false); }
	};
	return <div className="space-y-2" data-testid="local-dictation-settings">
		<SettingsRow label="Provider" testid="row-dictation-provider" dimmed={disabled}>
			<ThinSelect value={provider} ariaLabel="Dictation provider" disabled={disabled} onChange={value => { void preference.saveSettings({ provider: value as DictationProvider }); }}>
				<option value="deepgram">Deepgram</option><option value="local" disabled={status?.supported === false}>Local</option>
			</ThinSelect>
		</SettingsRow>
		{provider === "local" && <>
			<SettingsRow label="Model" hint={modelPath ? modelPath.split(/[\\/]/).at(-1) : "Not selected"}>
				<Button type="button" variant="outline" size="sm" disabled={disabled || !status?.supported} onClick={() => { void choose(); }}>Choose model file…</Button>
			</SettingsRow>
			<SettingsRow label="Parakeet Ultra Q8_0" hint="Recommended · 706 MiB · Russian, English + 23 languages">
				<Button type="button" variant="outline" size="sm" disabled={disabled || !status?.supported} onClick={() => { void download(); }}>
					{status?.download.active || working ? `Downloading… ${Math.floor((status?.download.bytes ?? 0) * 100 / RECOMMENDED_DICTATION_MODEL.size)}%` : status?.recommendedInstalled ? "Use recommended model" : "Download recommended model"}
				</Button>
			</SettingsRow>
			<SettingsRow label="Unload model after" dimmed={disabled}>
				<ThinSelect value={preference.settings?.unloadAfter ?? "never"} ariaLabel="Unload model after" disabled={disabled} onChange={value => { void preference.saveSettings({ unloadAfter: value as ModelUnloadAfter }); }}>
					{MODEL_UNLOAD_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
				</ThinSelect>
			</SettingsRow>
			<p role="status" className="px-1 text-xs text-muted-foreground">
				{status?.supported === false ? "Local dictation currently requires macOS on Apple Silicon or Linux x64." : status?.busy ? "Recognizing…" : status?.loaded ? "Model loaded" : status?.modelAvailable ? "Model file found · loads on first use" : "Choose a compatible ASR GGUF file or download the recommended model."}
			</p>
			<p className="px-1 text-[11px] text-muted-foreground/70">Audio is recognized locally. Language is detected by the model. No AI cleanup is applied. <a href="https://huggingface.co/handy-computer/parakeet-ultra-gguf" target="_blank" rel="noreferrer" className="underline">Parakeet Ultra · CC-BY-4.0</a></p>
		</>}
		{(error || preference.error || status?.download.error) && <p role="alert" className="px-1 text-xs text-destructive">{error ?? preference.error ?? status?.download.error}</p>}
	</div>;
}
