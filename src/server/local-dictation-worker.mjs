import { TranscribeModel } from 'transcribe-cpp';

let model;
let modelPath;
let busy = false;
process.once('disconnect', () => process.exit(0));
process.on('message', async ({ id, path, pcm }) => {
  if (busy) return;
  busy = true;
  try {
    if (modelPath !== path) {
      model?.dispose(); model = undefined; modelPath = undefined;
      model = await TranscribeModel.load(path);
      if (!model.roles.includes('asr')) throw new Error('The selected GGUF is not a speech recognition model.');
      modelPath = path;
    }
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    const result = await model.transcribe(samples);
    process.send?.({ id, text: result.text });
  } catch (error) {
    process.send?.({ id, error: error instanceof Error ? error.message.slice(0, 400) : 'Local recognition failed.' });
  } finally { busy = false; }
});
