#!/usr/bin/env node
// Public plugin API harness only: no native host, provider, credentials or existing profile.
// Run after `npm run build` in plugins/chess-training.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootRequire = createRequire(resolve(plugin, '../../package.json'));
const { default: puppeteer } = await import(rootRequire.resolve('puppeteer-core'));
const backend = createRequire(import.meta.url)(join(plugin, 'dist/chess-training/backend.cjs'));
const output = await mkdtemp(join(tmpdir(), 'chess-public-browser-'));
const profile = join(output, 'chrome-profile');
const dataDirectory = join(output, 'backend-data');
await mkdir(dataDirectory);
const evidence = {
  scope: 'BROWSER PUBLIC PLUGIN HARNESS — NOT native host/provider flow',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  output, pageErrors: [], blockedRequests: [], rpc: [], checkpoints: [],
  backendActivations: 0, result: 'running',
};
const fixtures = {
  main: {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    lines: [['e2e4', 'e7e5', 'g1f3']],
    hints: [['Start in the centre.', 'Advance the king pawn two squares.'],
      ['Develop a minor piece.', 'Move the kingside knight toward the centre.']],
  },
  promotion: {
    fen: '7k/P7/8/8/8/8/8/7K w - - 0 1',
    lines: [['a7a8n']], hints: [['Choose an underpromotion.']],
  },
};
let handlers = new Map();
let backendSignal;
let disposeBackend;
let browser;
let page;
let server;
let origin;
let cleaning;
function activateBackend() {
  backendSignal = new AbortController();
  let definition;
  disposeBackend = backend.activate({
    dataDirectory, signal: backendSignal.signal,
    handle(name, fn) {
      assert(!handlers.has(name)); handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    registerQuestionType(value) { definition = value; return () => {}; },
    registerInstructions() { return () => {}; },
    registerTools() { return () => {}; },
  });
  assert.equal(definition.id, 'puzzle');
  assert.equal(definition.contractVersion, 1);
  assert.equal(definition.probe.toolName, 'chess_training_probe');
  assert.equal(definition.teach.toolName, 'chess_training_question');
  assert.equal(definition.showThinking, true);
  for (const payload of Object.values(fixtures)) {
    assert.equal(definition.validateQuestion({ input: { payload } }), undefined);
  }
  evidence.backendActivations++;
}
const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Chess training public plugin browser harness</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css">
<style>:root{--background:#fff;--foreground:#202020;--border:#777}body{font:16px system-ui;margin:24px}h1{font-size:20px}#host{margin-top:16px}#host button{padding:10px}</style>
</head><body><h1>PUBLIC PLUGIN HARNESS — not native host/provider flow</h1>
<p id="question">Play the central pawn, then develop your kingside knight.</p>
<div id="editor"></div><div id="replay"></div><div id="host"><button id="submit" disabled>Synthetic manual host Submit</button>
<p id="host-state">empty</p><p>Manual submissions: <span id="submissions">0</span></p></div>
<script type="module">
import { activate } from '/main.js';
const signal = new AbortController();
const fixture = new URL(location.href).searchParams.get('fixture') || 'main';
const variant = fixture === 'promotion' ? 'teach' : 'probe';
const payload = await fetch('/fixture?name=' + fixture).then(r => r.json());
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
window.smoke = { answer: { status: 'empty' }, changes: [], submissions: 0, mounted: false };
let renderer;
const unregister = activate({
  signal: signal.signal,
  registerQuestionRenderer(value) { renderer = value; return () => { renderer = undefined; }; },
  registerToolRenderer() { return () => {}; },
  async call(method, params) {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  },
});
if (renderer.id !== 'puzzle' || !renderer.supportedContractVersions.includes(1)) throw new Error('Missing public renderer');
let handle;
handle = await renderer.mountAnswerEditor(document.querySelector('#editor'), {
  input: freeze({ ...(variant === 'teach' ? { type: 'predict', nodeId: 'synthetic-node' } : {}), question: document.querySelector('#question').textContent, payload }),
  chatId: 'synthetic-browser-chat', questionId: 'synthetic-' + fixture,
  contractVersion: 1, variant, signal: signal.signal, active: true,
  answer: { status: 'empty' },
  onChange(answer) {
    window.smoke.answer = structuredClone(answer);
    window.smoke.changes.push(structuredClone(answer));
    document.querySelector('#submit').disabled = answer.status !== 'ready';
    document.querySelector('#host-state').textContent = answer.status;
    // Exercise controlled updates without echoing publication, outside the mount stack.
    queueMicrotask(() => handle?.update({ answer, active: true }));
  },
});
window.smoke.mounted = true;
let disposeReplay;
document.querySelector('#submit').addEventListener('click', () => {
  if (window.smoke.answer.status !== 'ready') throw new Error('Unready manual submission');
  document.querySelector('#submissions').textContent = ++window.smoke.submissions;
  disposeReplay?.();
  disposeReplay = renderer.mountAnswered(document.querySelector('#replay'), {
    input: freeze({ question: document.querySelector('#question').textContent, payload }),
    answer: freeze(structuredClone(window.smoke.answer.value)), signal: signal.signal,
    chatId: 'synthetic-browser-chat', questionId: 'synthetic-' + fixture, contractVersion: 1, variant,
  });
});
window.addEventListener('pagehide', () => { signal.abort(); disposeReplay?.(); handle.dispose(); unregister(); }, { once: true });
</script></body></html>`;

const lessonHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css">
<style>:root{--background:#fff;--foreground:#202020;--border:#777}body{font:16px system-ui;margin:24px}#lessons{display:flex;gap:24px;align-items:start}#lessons>div{width:350px}</style></head><body>
<h1>Disposable public lesson renderer harness</h1><div id="lessons"><div id="a"></div><div id="b"></div></div><div id="promotion"></div>
<script type="module">
import { activate } from '/main.js';
const activation = new AbortController(); let renderer;
window.lessonSmoke = { calls: 0, submissions: 0, disposed: false };
const unregister = activate({ signal: activation.signal,
  registerQuestionRenderer() { return () => {}; },
  registerToolRenderer(value) { renderer = value; return () => {}; },
  call() { window.lessonSmoke.calls++; throw new Error('Lessons must not call backend'); },
});
const artifact = { version: 1, title: 'Explore the centre', explanation: 'Public lesson explanation', orientation: 'white',
  fen: '${fixtures.main.fen}',
  annotations: { explanation: 'Root markings', arrows: [{ from: 'e2', to: 'e4', color: 'green' }], circles: [{ square: 'd4', color: 'red' }], highlights: [{ square: 'e4', color: 'blue' }] },
  variations: [{ name: 'King pawn', moves: ['e2e4','e7e5'], annotations: [{ ply: 1, explanation: 'Black responds', arrows: [{ from: 'e7', to: 'e5', color: 'yellow' }] }] }, { name: 'Queen pawn', moves: ['d2d4','d7d5'] }],
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
freeze(artifact);
const handles = ['a','b'].map(id => renderer.mount(document.querySelector('#' + id), { input: artifact, output: artifact, toolName: 'chess_training_lesson', toolCallId: 'same-id', state: 'output-available', signal: activation.signal }));
handles.push(renderer.mount(document.querySelector('#promotion'), { input: {}, output: { version: 1, title: 'Promotion', explanation: 'Choose explicitly', orientation: 'white', fen: '${fixtures.promotion.fen}', variations: [] }, toolName: 'chess_training_lesson', toolCallId: 'promotion', state: 'output-available', signal: activation.signal }));
window.lessonSmoke.dispose = () => { activation.abort(); handles.forEach(dispose => { dispose(); dispose(); }); unregister(); window.lessonSmoke.disposed = true; };
window.lessonSmoke.mounted = true;
window.addEventListener('pagehide', window.lessonSmoke.dispose, { once: true });
</script></body></html>`;

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    try { await browser?.close(); }
    finally {
      try {
        if (server?.listening) {
          server.closeAllConnections();
          await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
        }
      } finally {
        try { await disposeBackend?.(); backendSignal?.abort(); }
        finally { await Promise.all([profile, dataDirectory].map(path => rm(path, { recursive: true, force: true }))); }
      }
    }
  })();
  return cleaning;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
});
async function settled(expected) {
  await page.waitForFunction(expected => {
    const s = window.smoke;
    return s?.mounted && s.answer.value && JSON.stringify(s.answer.value) === JSON.stringify(expected)
      && !document.querySelector('[aria-label="UCI move"]').disabled;
  }, { timeout: 10000 }, expected);
}
async function ready(expected) {
  await page.waitForFunction(expected => window.smoke?.answer.status === 'ready'
    && JSON.stringify(window.smoke.answer.value) === JSON.stringify(expected), { timeout: 10000 }, expected);
}
async function boardClick(square) {
  const box = await page.$eval('cg-board', element => {
    const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  await page.mouse.click(box.x + (file + 0.5) * box.width / 8, box.y + (8 - rank + 0.5) * box.height / 8);
}
async function move(from, to) { await boardClick(from); await boardClick(to); }
async function assertPiece(square, color, role) {
  const found = await page.evaluate(({ square, color, role }) => {
    const r = document.querySelector('cg-board').getBoundingClientRect();
    return [...document.querySelectorAll('cg-board piece.' + color + '.' + role + ':not(.ghost)')].some(p => {
      const b = p.getBoundingClientRect();
      return Math.abs((b.x + b.width / 2 - r.x) / r.width * 8 - (square.charCodeAt(0) - 97 + 0.5)) < 0.1
        && Math.abs((b.y + b.height / 2 - r.y) / r.height * 8 - (8 - Number(square[1]) + 0.5)) < 0.1;
    });
  }, { square, color, role });
  assert(found, `${color} ${role} visibly placed at ${square}`);
}
async function assertCoordinates(scope = '.chess-training') {
  const boards = await page.$$eval(scope + ' .cg-wrap', elements => elements.map(element => {
    const board = element.querySelector('cg-board').getBoundingClientRect();
    return ['ranks', 'files'].map(kind => {
      const labels = element.querySelector('coords.' + kind);
      const bounds = labels.getBoundingClientRect();
      const style = getComputedStyle(labels);
      return { kind, outside: kind === 'ranks' ? bounds.right <= board.left + 1 : bounds.top >= board.bottom - 1,
        fontSize: parseFloat(style.fontSize), opacity: style.opacity, color: style.color, background: style.backgroundColor,
        offsets: [...labels.children].map(label => {
          const r = label.getBoundingClientRect();
          return kind === 'ranks' ? (r.y + r.height / 2 - board.y) / board.height * 8 : (r.x + r.width / 2 - board.x) / board.width * 8;
        }).sort((a, b) => a - b) };
    });
  }));
  assert(boards.length > 0, 'Coordinate check has a mounted board');
  for (const labels of boards.flat()) {
    assert(labels.outside, `${labels.kind} coordinates outside board`);
    assert(labels.fontSize >= 14 && labels.opacity === '1' && labels.color === 'rgb(240, 240, 240)' && labels.background === 'rgb(20, 20, 20)', 'Readable coordinate styling');
    assert.equal(labels.offsets.length, 8);
    labels.offsets.forEach((offset, i) => assert(Math.abs(offset - (i + .5)) < .05, 'Coordinate centered on its file/rank'));
  }
}
async function checkpoint(name) {
  await assertCoordinates();
  const observation = await page.evaluate(() => ({
    answer: window.smoke.answer, submissions: window.smoke.submissions,
    status: document.querySelector('[role="status"]').textContent,
    hints: [...document.querySelectorAll('.chess-training-hints li')].map(e => e.textContent),
    submitDisabled: document.querySelector('#submit').disabled,
    board: (() => { const b = document.querySelector('cg-board').getBoundingClientRect(); return { width: b.width, height: b.height }; })(),
    pieces: [...document.querySelectorAll('cg-board piece:not(.ghost)')].map(p => ({
      classes: p.className, background: getComputedStyle(p).backgroundImage,
      width: p.getBoundingClientRect().width, height: p.getBoundingClientRect().height,
    })),
  }));
  assert(observation.board.width > 100 && observation.board.height > 100, 'Rendered board geometry');
  assert(observation.pieces.length > 0 && observation.pieces.every(p => p.width > 0 && p.height > 0 && p.background.includes('data:image/svg+xml')), 'Rendered embedded piece CSS');
  assert.equal(observation.submissions, 0, 'Plugin never submits automatically');
  await page.screenshot({ path: join(output, name + '.png'), fullPage: true });
  evidence.checkpoints.push({ name, ...observation });
  return observation;
}
async function visibleHints(expected) {
  assert.deepEqual(await page.$$eval('.chess-training-hints li', items => items.map(e => e.textContent)), expected);
  const body = await page.$eval('body', e => e.innerText);
  for (const hints of fixtures.main.hints) for (const hint of hints) {
    assert.equal(body.includes(hint), expected.some(text => text.includes(hint)), `Hint visibility: ${hint}`);
  }
}

async function exerciseLessons() {
  const rpcBefore = evidence.rpc.length;
  await page.goto(origin + '/?lesson', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.lessonSmoke?.mounted);
  async function clickButton(scope, text) {
    const buttons = await page.$$(scope + ' button');
    for (const button of buttons) if (await button.evaluate(el => el.textContent) === text) { await button.click(); return; }
    throw new Error('Missing lesson button: ' + text);
  }
  async function contains(scope, text) { await page.waitForFunction((scope, text) => document.querySelector(scope).textContent.includes(text), {}, scope, text); }
  async function point(scope, square) {
    await page.$eval(scope + ' cg-board', el => el.scrollIntoView({ block: 'center' }));
    return page.$eval(scope + ' cg-board', (el, square) => { const r = el.getBoundingClientRect(); return { x: r.x + (square.charCodeAt(0) - 97 + .5) * r.width / 8, y: r.y + (8 - Number(square[1]) + .5) * r.height / 8 }; }, square);
  }
  async function squareClick(scope, square) { const p = await point(scope, square); await page.mouse.click(p.x, p.y); }
  async function markings(scope, arrows, circles, highlights) {
    await page.waitForFunction((scope, arrows, circles, highlights) => {
      const el = document.querySelector(scope);
      return el.querySelectorAll('svg.cg-shapes line').length === arrows && el.querySelectorAll('svg.cg-shapes circle').length === circles && [...el.querySelectorAll('square.chess-training-highlight-blue')].filter(square => getComputedStyle(square).display !== 'none').length === highlights;
    }, { timeout: 5000 }, scope, arrows, circles, highlights).catch(async error => {
      const observed = await page.$eval(scope, el => ({ arrows: el.querySelectorAll('svg.cg-shapes line').length, circles: el.querySelectorAll('svg.cg-shapes circle').length, highlights: [...el.querySelectorAll('square.chess-training-highlight-blue')].filter(square => getComputedStyle(square).display !== 'none').length }));
      throw new Error(`${scope} markings expected ${arrows}/${circles}/${highlights}: ${JSON.stringify(observed)}`, { cause: error });
    });
  }
  await contains('#a', 'Public lesson explanation'); await markings('#a', 1, 1, 1);
  await assertCoordinates();
  await page.screenshot({ path: join(output, '10-lesson-root-markings.png'), fullPage: true });
  await squareClick('#a', 'e2'); await squareClick('#a', 'e4');
  await contains('#a', 'Moves: e2e4'); await contains('#a', 'Black to move');
  assert.equal(await page.$eval('#b .chess-training-moves', el => el.textContent), 'Moves: —');
  await markings('#a', 0, 0, 0); await markings('#b', 1, 1, 1);
  const from = await point('#a', 'e7'), to = await point('#a', 'e5');
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  await contains('#a', 'Moves: e2e4 e7e5');
  await page.type('#a input', 'g1f3'); await page.focus('#a input'); await page.keyboard.press('Enter');
  await contains('#a', 'Moves: e2e4 e7e5 g1f3');
  await clickButton('#a', 'Undo'); assert.equal(await page.$eval('#a .chess-training-moves', el => el.textContent), 'Moves: e2e4 e7e5');
  await clickButton('#a', 'Reset'); await markings('#a', 1, 1, 1);
  await page.select('#a select', '0'); await clickButton('#a', 'Next ply'); await contains('#a', 'Black responds'); await markings('#a', 1, 0, 0);
  await clickButton('#a', 'Next ply'); await contains('#a', 'Moves: e2e4 e7e5');
  await clickButton('#a', 'Previous ply'); assert.equal(await page.$eval('#a .chess-training-moves', el => el.textContent), 'Moves: e2e4');
  await page.select('#a select', '1'); await clickButton('#a', 'Next ply'); await contains('#a', 'Moves: d2d4');
  await markings('#a', 0, 0, 0); await markings('#b', 1, 1, 1);
  await page.screenshot({ path: join(output, '11-lesson-independent-branches.png'), fullPage: true });
  await squareClick('#promotion', 'a7'); await squareClick('#promotion', 'a8');
  await page.waitForSelector('#promotion [aria-label="Choose promotion piece"]', { visible: true });
  assert.equal(await page.$eval('#promotion .chess-training-moves', el => el.textContent), 'Moves: —');
  await clickButton('#promotion', 'Knight'); await contains('#promotion', 'Moves: a7a8n');
  await clickButton('#promotion', 'Reset'); await page.type('#promotion input', 'a7a8r'); await page.focus('#promotion input'); await page.keyboard.press('Enter');
  await contains('#promotion', 'Moves: a7a8r');
  await page.screenshot({ path: join(output, '12-lesson-promotion.png'), fullPage: true });
  assert.deepEqual(await page.evaluate(() => ({ calls: window.lessonSmoke.calls, submissions: window.lessonSmoke.submissions })), { calls: 0, submissions: 0 });
  assert.equal(evidence.rpc.length, rpcBefore);
  await page.evaluate(() => window.lessonSmoke.dispose());
  assert.equal(await page.$$eval('.chess-training-lesson', elements => elements.length), 0);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.lessonSmoke?.mounted);
  assert.deepEqual(await page.$$eval('#a .chess-training-moves, #b .chess-training-moves, #promotion .chess-training-moves', elements => elements.map(el => el.textContent)), ['Moves: —', 'Moves: —', 'Moves: —']);
  await markings('#a', 1, 1, 1); await markings('#b', 1, 1, 1);
  assert.equal(evidence.rpc.length, rpcBefore);
  await page.evaluate(() => window.lessonSmoke.dispose());
  evidence.checkpoints.push({ name: 'lesson-interactive', reloadResetsLocalExploration: true, click: true, drag: true, keyboardUci: true, annotations: ['arrow', 'circle', 'highlight'], independentOccurrences: true, navigation: true, explicitPromotion: true, reset: true, abortAndRepeatedDispose: true, calls: 0, submissions: 0 });
}

try {
  activateBackend();
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(url.searchParams.has('lesson') ? lessonHtml : html);
      } else if (req.method === 'GET' && ['/main.js', '/styles.css'].includes(url.pathname)) {
        res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(await readFile(join(plugin, 'dist/chess-training', url.pathname.slice(1))));
      } else if (req.method === 'GET' && url.pathname === '/fixture') {
        assert(Object.hasOwn(fixtures, url.searchParams.get('name')));
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(fixtures[url.searchParams.get('name')]));
      } else if (req.method === 'POST' && url.pathname === '/rpc') {
        let body = '';
        for await (const chunk of req) { body += chunk; assert(body.length < 65536); }
        const { method, params } = JSON.parse(body);
        assert(handlers.has(method), 'Unknown RPC method');
        const result = await handlers.get(method)(params);
        evidence.rpc.push({ activation: evidence.backendActivations, method, params, result });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
      } else { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  origin = `http://127.0.0.1:${server.address().port}`;
  evidence.origin = origin;
  browser = await puppeteer.launch({
    executablePath: evidence.chrome, userDataDir: profile, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync'],
  });
  evidence.browserVersion = await browser.version();
  page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 950, deviceScaleFactor: 1 });
  page.on('pageerror', error => evidence.pageErrors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    // Embedded artwork is non-network data. All actual HTTP traffic must be our owned origin.
    if (url.origin === origin || url.protocol === 'data:') void request.continue();
    else { evidence.blockedRequests.push(request.url()); void request.abort('blockedbyclient'); }
  });
  const initial = { moves: [], incorrectAttempts: [], revealedHints: [] };
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await settled(initial);
  await visibleHints([]);
  assert.equal((await checkpoint('01-initial')).submitDisabled, true);

  await move('d2', 'd4');
  const retry = { ...initial, incorrectAttempts: [{ atPly: 0, move: 'd2d4' }] };
  await settled(retry);
  await assertPiece('d2', 'white', 'pawn');
  assert.equal((await checkpoint('02-neutral-rollback')).status, 'That legal move is not included in the authored puzzle lines. Its chess quality has not been established. Try another move.');
  await visibleHints([]);
  await page.click('[aria-label="Reveal next hint"]');
  const hinted = { ...retry, revealedHints: [{ learnerMove: 0, count: 1 }] };
  await settled(hinted);
  await visibleHints(['Move 1: Start in the centre.']);
  await checkpoint('03-first-hint');
  await page.click('[aria-label="Reveal next hint"]');
  const both = { ...retry, revealedHints: [{ learnerMove: 0, count: 2 }] };
  await settled(both);
  await visibleHints(['Move 1: Start in the centre.', 'Move 1: Advance the king pawn two squares.']);
  assert.equal(await page.$eval('[aria-label="Reveal next hint"]', e => e.disabled), true);

  await move('e2', 'e4');
  const progressed = { ...both, moves: ['e2e4', 'e7e5'] };
  await settled(progressed);
  await assertPiece('e4', 'white', 'pawn');
  await assertPiece('e5', 'black', 'pawn');
  await visibleHints(['Move 1: Start in the centre.', 'Move 1: Advance the king pawn two squares.']);
  await checkpoint('04-automatic-opponent');
  await page.reload({ waitUntil: 'networkidle0' });
  await settled(progressed);
  await assertPiece('e4', 'white', 'pawn');
  await assertPiece('e5', 'black', 'pawn');
  await visibleHints(['Move 1: Start in the centre.', 'Move 1: Advance the king pawn two squares.']);
  await checkpoint('05-full-reload-restored');

  await disposeBackend(); backendSignal.abort();
  assert.equal(handlers.size, 0);
  activateBackend();
  await page.reload({ waitUntil: 'networkidle0' });
  await settled(progressed);
  await assertPiece('e4', 'white', 'pawn');
  await assertPiece('e5', 'black', 'pawn');
  await visibleHints(['Move 1: Start in the centre.', 'Move 1: Advance the king pawn two squares.']);
  await checkpoint('06-backend-reactivation-restored');
  await move('g1', 'f3');
  const completed = { ...progressed, moves: ['e2e4', 'e7e5', 'g1f3'] };
  await ready(completed);
  await assertPiece('f3', 'white', 'knight');
  assert.equal((await checkpoint('07-complete-not-submitted')).submitDisabled, false);

  const replayRpcBefore = evidence.rpc.length;
  await page.click('#submit');
  assert.equal(await page.$('#replay cg-board'), null);
  await page.click('#replay > .chess-training > button');
  await page.waitForSelector('#replay cg-board');
  await assertCoordinates('#replay .chess-training');
  assert.match(await page.$eval('#replay [role="status"]', el => el.textContent), /Move 3 of 3/);
  const replayButtons = await page.$$('#replay section button');
  for (let i = 0; i < 3; i++) await replayButtons[0].click();
  assert.match(await page.$eval('#replay [role="status"]', el => el.textContent), /starting position/);
  assert.equal(await replayButtons[0].evaluate(el => el.disabled), true);
  for (let i = 0; i < 3; i++) await replayButtons[1].click();
  assert.equal(await replayButtons[1].evaluate(el => el.disabled), true);
  const replayBoard = await page.$eval('#replay cg-board', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; });
  await page.mouse.move(replayBoard.x + replayBoard.width * 5.5 / 8, replayBoard.y + replayBoard.width * 5.5 / 8);
  await page.mouse.down(); await page.mouse.move(replayBoard.x + replayBoard.width * 4.5 / 8, replayBoard.y + replayBoard.width * 3.5 / 8, { steps: 8 }); await page.mouse.up();
  assert.match(await page.$eval('#replay [role="status"]', el => el.textContent), /Move 3 of 3/);
  assert.deepEqual(await page.evaluate(() => window.smoke.answer.value), completed);
  assert.equal(evidence.rpc.length, replayRpcBefore, 'Replay never reads or writes progress');
  await page.screenshot({ path: join(output, '07b-answered-replay.png'), fullPage: true });

  await page.goto(origin + '/?fixture=promotion', { waitUntil: 'networkidle0' });
  await settled(initial);
  await move('a7', 'a8');
  await page.waitForSelector('[aria-label="Choose promotion piece"]', { visible: true });
  assert.equal(await page.evaluate(() => window.smoke.answer.status), 'unready');
  assert.equal(await page.evaluate(() => window.smoke.answer.value.moves.length), 0);
  await checkpoint('08-explicit-promotion-choice');
  const knight = await page.$('::-p-text(Knight)');
  assert(knight); await knight.click();
  await ready({ ...initial, moves: ['a7a8n'] });
  await assertPiece('a8', 'white', 'knight');
  await checkpoint('09-underpromotion-not-submitted');
  await exerciseLessons();
  assert.deepEqual(evidence.pageErrors, []);
  assert.deepEqual(evidence.blockedRequests, []);
  assert.equal(evidence.backendActivations, 2);
  evidence.result = 'PASS';
} catch (error) {
  evidence.result = 'FAIL'; evidence.error = error.stack || String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) { evidence.cleanupError = String(error); evidence.result = 'FAIL'; process.exitCode = 1; }
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`${evidence.result}: ${evidence.scope}\nArtifacts: ${output}`);
  if (evidence.error) console.error(evidence.error);
}
