# Local dictation

## User-facing contract

Settings → Providers → Dictation offers **Deepgram** and **Local**. Existing installations keep Deepgram. Local recognition currently supports macOS on Apple Silicon or Linux x64 and does not require Handy, an API key, or a separate server.

- **Mod+D** or the microphone button starts recording. Repeat it to stop, recognize and append the transcript. Both providers share the same capture lifecycle: an active run always delivers into the destination it started with, even if focus moves.
- **Enter / Submit** while recording or recognizing finishes dictation first: capture stops, recognition completes, the transcript lands in its destination, and only then is the submission sent. With the local provider this waits for recognition, so a cold model load delays the send rather than losing speech. A recognition failure shows its error and does not send.
- **Esc** cancels the run and discards its pending transcript, as with Deepgram.
- Stop turns off the microphone immediately, then waits for the processor's final partial PCM frame before recognition. The processor must acknowledge completion within **3 seconds**; otherwise an explicit error is shown without inserting a partial transcript. Cancellation discards capture without draining it.
- Leaving the page cancels its capture and pending result. A late transcript never reaches another page.
- The first use loads the native model. Subsequent recordings reuse it. **Unload model after** offers **5 minutes**, **1 hour**, **Never**; the default is **Never**. Idle timers do not interrupt recognition. Quitting the server releases its child process.
- Failures are explicit. Local recognition never silently falls back to a cloud service. No LLM cleanup is performed.

## Models

The recommended download is **Parakeet Ultra Q8_0**, pinned to Hugging Face revision `39eeb55181f0d354fd934f06e92fd8d5037fed8e`. Installation is initiated only by the user, bounded to the published size and verified against SHA-256 before atomic rename. Existing files are not replaced by a partial/failed download. Settings can instead reference a compatible, trusted ASR GGUF file without copying it. The GGUF header is checked before use; full compatibility is checked by the native engine at load time.

The model is 740,363,168 bytes (about 706 MiB) on disk, not an estimate of process RAM. It supports 25 European languages, including Russian and English, with automatic language detection. It is batch ASR, not live partial transcription. The Deepgram language preference does not restrict local language detection.

Attribution: Parakeet Ultra by **Moondream**, GGUF conversion by **handy-computer**, licensed **CC-BY-4.0**. [Pinned model card and terms](https://huggingface.co/handy-computer/parakeet-ultra-gguf/blob/39eeb55181f0d354fd934f06e92fd8d5037fed8e/README.md). Weights are not bundled in the application. The engine and binding are distributed by `transcribe-cpp@0.4.1` (MIT); installed dependencies retain their licenses.

## Implementation

The existing renderer AudioWorklet captures 16 kHz mono signed PCM16 and supplies the same meter for both providers. Local PCM is retained until explicit stop, bounded to **32 MiB** (roughly 17 minutes). Exceeding the bound ends capture with an explicit error, not a truncated transcript. It is sent to the local app server and is not written to disk. Model initialization and recognition run in an isolated, long-lived Node child through `transcribe-cpp` and its prebuilt package for the platform: Metal on Apple Silicon, CPU/Vulkan on Linux x64. In browser-only mode (a self-hosted server reached by name), the recognition route accepts the same hosts and same-origin requests as every other API route; the app itself adds no login, so such a server needs its own access gate. This isolates native crashes; it is **not a security sandbox for untrusted model files**.

One server-wide engine admits one operation at a time, before reading the request body. Cancellation, a crash or timeout tears down the child before allowing another operation. Model lifetime is independent of page navigation; cancellation may release the model to stop in-flight native work. A successful run restarts its selected idle policy. Changes to the idle preference also apply to an already-loaded idle model.

Native dependencies and the unbundled worker are explicitly included in the Next standalone trace. Only the helper imports the native binding; a local-status request does not initialize Metal or load model weights.

## HTTP contract

Same-repo frontend callers use the following additive, unversioned local endpoints. All are no-store, same-origin/loopback only and inherit the desktop HTTP capability gate. No CORS allowance, arbitrary URL, arbitrary command or inference model override is exposed.

- `GET /api/stt/local`: availability, current engine activity, download progress and recommended-model installation status. Does not start recognition. Paths describe this local user's configured installation only.
- `POST /api/stt/local`: `Content-Type: application/octet-stream`, raw 16 kHz mono signed PCM16 (nonempty, even byte count, ≤32 MiB). Uses the currently configured local model. Returns `{text}`. Concurrent work is refused with 409; requests are not retried automatically. The operation has a two-minute safety deadline. Disconnect/cancel discards the result and stops the isolated process.
- `POST /api/stt/local/model`: explicitly downloads the one pinned recommended model. Returns `{modelPath}` only after verification and installation. A concurrent download is 409. No caller-supplied source URL or destination is accepted. Partial files are private and removed after failure/cancellation.

Errors use `{code, message}`: invalid input 400, unsupported content type 415, oversized audio 413, missing/invalid model 422, concurrent/provider-changed 409, forbidden 403, unsupported platform 503, recognition failure 500, timeout 504, canceled request 499. Messages do not contain transcripts. No audio/text is sent to the conversation model by these endpoints. They have no list/pagination surface.

Settings remain a whole-section `PUT /api/settings/dictation`: optional `language`, `provider` (`deepgram`/`local`), `modelPath` (absolute GGUF path or empty), `unloadAfter` (`5m`/`1h`/`never`). Language writes preserve the other fields through the shared confirmed preference store.

## Verification

Deterministic tests cover preferences, request guards and audio bounds, verified/atomic installation, native-process reuse/crash/cancellation, idle policies, local recognition without cloud token minting, and discarding late results after cancel or unmount. The shipped AudioWorklet also runs in a VM test: every sample, including a sub-frame tail, must arrive exactly once before acknowledgement; hook tests cover both providers, stop during socket opening, acknowledgement failure and cancellation while draining. Test helpers use synthetic models/audio and never invoke real providers.

Real-engine smoke (supply your own installed model and synthetic/owned PCM):

```sh
node --import tsx scripts/smoke-local-dictation.mjs /absolute/model.gguf /absolute/16khz-mono.pcm
ELECTRON_RUN_AS_NODE=1 /path/to/Electron --import tsx scripts/smoke-local-dictation.mjs /absolute/model.gguf /absolute/16khz-mono.pcm
```

The smoke runs two recognitions in one child, checks matching nonempty output and awaited cleanup, and performs no downloads or learning-profile writes. Pass an optional third argument with a standalone payload directory to exercise its shipped worker and native dependencies rather than those in the checkout. Production standalone/native execution and actual microphone delivery require separate smoke coverage; Node unit tests alone are not proof of either.
