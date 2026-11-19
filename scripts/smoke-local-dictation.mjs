// Run with: node --import tsx scripts/smoke-local-dictation.mjs MODEL.gguf AUDIO.pcm [STANDALONE]
// Audio must be owned/synthetic 16 kHz mono signed PCM16. No downloads or profile writes.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { LocalDictationEngine } from '../src/server/local-dictation.ts';

const [model, audio, standalone] = process.argv.slice(2);
const worker = standalone ? path.resolve(standalone, 'src/server/local-dictation-worker.mjs') : fileURLToPath(new URL('../src/server/local-dictation-worker.mjs', import.meta.url));
if (standalone) {
  const root = await realpath(standalone);
  const require = createRequire(worker);
  assert.equal(JSON.parse(await readFile(path.join(root, 'node_modules/transcribe-cpp/package.json'), 'utf8')).name, 'transcribe-cpp');
  const relative = path.relative(root, require.resolve('koffi'));
  assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Koffi escaped the standalone payload');
}
assert(model && audio, 'Usage: MODEL.gguf AUDIO.pcm');
const pcm = await readFile(audio);
let launches = 0;
const engine = new LocalDictationEngine(() => {
  launches++;
  return fork(worker, [], {
    execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
});
try {
  const times = [];
  const outputs = [];
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    outputs.push(await engine.transcribe(async () => pcm, model, 'never', new AbortController().signal));
    times.push(Math.round(performance.now() - start));
  }
  assert.equal(launches, 1);
  assert.equal(engine.loaded, true);
  assert.equal(engine.busy, false);
  assert(outputs[0].trim().length > 0, 'Expected recognized speech');
  assert.equal(outputs[0], outputs[1]);
  console.log(JSON.stringify({ result: 'PASS', launches, coldMs: times[0], warmMs: times[1], text: outputs[0] }));
} finally { await engine.dispose(); }
assert.equal(engine.loaded, false);
