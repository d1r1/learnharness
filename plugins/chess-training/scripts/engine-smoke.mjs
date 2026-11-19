// Explicit real-engine check; ordinary tests use fake transport instead.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'chess-engine-smoke-'));
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
let dispose;
try {
  const directory = join(root, 'chess-training');
  const dataDirectory = join(root, 'disposable-profile');
  await cp(fileURLToPath(new URL('../dist/chess-training/', import.meta.url)), directory, { recursive: true });
  await mkdir(dataDirectory);
  process.chdir(root);
  globalThis.fetch = () => { throw new Error('Network is forbidden in the engine smoke'); };
  const contributions = [];
  const activation = new AbortController();
  dispose = createRequire(import.meta.url)(join(directory, 'backend.cjs')).activate({
    directory, dataDirectory, signal: activation.signal,
    handle() { return () => {}; }, registerQuestionType() { return () => {}; },
    registerInstructions() { return () => {}; },
    registerTools(value) { contributions.push(value); return () => {}; },
  });
  const contribution = contributions.find(value => value.agents.includes('prober'));
  assert.deepEqual(contribution.agents, ['teacher', 'prober']);
  const [tool] = contribution.create({ chatId: 'disposable', agent: 'prober' });
  assert.equal(tool.name, 'chess_training_analyze');
  for (const [file, hash] of [
    ['stockfish-19-lite-single.js', 'ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a'],
    ['stockfish-19-lite-single.wasm', 'ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de'],
  ]) assert.equal(createHash('sha256').update(await readFile(join(directory, 'engine', file))).digest('hex'), hash);
  const positions = [
    { fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', move: 'h5f7', mate: 1 },
    { fen: '6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1', move: 'e1e8', mate: 1 },
    { fen: '4r1k1/8/8/8/8/8/5PPP/6K1 b - - 0 1', move: 'e8e1', mate: 1 },
    { fen: '6k1/8/8/3q4/4P3/8/8/6K1 w - - 0 1', move: 'e4d5' },
  ];
  const results = [];
  for (const position of positions) {
    const { details } = await tool.execute('synthetic', { fen: position.fen, candidates: [position.move] }, new AbortController().signal);
    assert.equal(details.completed, true, JSON.stringify(details));
    assert.ok(details.elapsedMs <= 3000);
    assert.equal(details.searches[0].bestmove, position.move);
    assert.equal(details.searches[1].bestmove, position.move);
    assert.equal(details.scorePerspective, position.fen.split(' ')[1] === 'w' ? 'white' : 'black');
    for (const search of details.searches) {
      assert.ok(search.requestedTimeMs <= 200);
      assert.equal(search.evidence.score.perspective, details.scorePerspective);
      if (position.mate) {
        assert.equal(search.evidence.score.unit, 'mate');
        assert.equal(search.evidence.score.value, position.mate);
      }
    }
    results.push({ move: position.move, elapsedMs: details.elapsedMs, perspective: details.scorePerspective, scores: details.searches.map(search => search.evidence.score) });
  }
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // Only the disposable package is changed: prove parent timers survive a non-yielding thread.
  const workerPath = join(directory, 'engine-worker.cjs');
  const originalWorker = await readFile(workerPath);
  const hangResults = [];
  try {
    for (const stage of ['init', 'search']) {
      await writeFile(workerPath, stage === 'init' ? 'while (true) {}' : `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', line => {
          if (line === 'uci') parentPort.postMessage('uciok');
          if (line === 'isready') parentPort.postMessage('readyok');
          if (line.startsWith('go ')) while (true) {}
        });
      `);
      const hung = await tool.execute('fake-hang', { fen: startFen }, new AbortController().signal);
      assert.equal(hung.details.reason, stage === 'init' ? 'request-budget' : 'search-budget');
      assert.equal(hung.details.partial, true);
      assert.ok(hung.details.elapsedMs <= 3000, JSON.stringify(hung.details));
      hangResults.push({ stage, reason: hung.details.reason, elapsedMs: hung.details.elapsedMs });
    }
  } finally { await writeFile(workerPath, originalWorker); }
  const pending = tool.execute('disable', { fen: startFen, candidates: ['e2e4', 'd2d4'] }, new AbortController().signal);
  await assert.rejects(tool.execute('busy', { fen: startFen }, new AbortController().signal), /busy/);
  const cancelTimer = setTimeout(() => activation.abort(), 100);
  const cancelled = await pending;
  clearTimeout(cancelTimer);
  assert.equal(cancelled.details.reason, 'cancelled');
  await dispose();
  await assert.rejects(tool.execute('late', { fen: startFen }), /cancelled/);
  assert.deepEqual(await readdir(dataDirectory), [], 'analysis never writes learner data');
  console.log(JSON.stringify({ runtime: process.versions, syntheticPositions: results, unresponsiveThreadChecks: hangResults, realCancellation: cancelled.details.reason, groups: 10, strengthValidation: false, installed: false }, null, 2));
} finally {
  await dispose?.();
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}
