import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { mountEditor, activate } from '../src/main.js';
import { mountReplay } from '../src/replay.js';
import { createStore } from '../src/store.js';
import { initialState } from '../src/core.js';

const identity = { chatId: 'frontend-chat', questionId: 'exact-question', contractVersion: 1 };
const puzzle = () => ({
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  lines: [['e2e4', 'e7e5', 'g1f3']],
  hints: [['First private hint', 'Second private hint'], ['Private knight hint']],
});
const move = uci => ({ type: 'move', uci });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate, label = 'condition') {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(5);
  }
}

// Each test owns its DOM globals, actual on-disk store and all mounted handles.
// The interceptor can delay a real store response or lose it after commit; it
// never fabricates progress. Unknown calls (including submission) fail closed.
async function fixture(t, payload = puzzle()) {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document,
    AbortController: dom.window.AbortController,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const directory = await mkdtemp(join(tmpdir(), 'chess-frontend-'));
  const stores = [];
  const handles = [];
  const f = {
    dom, payload, calls: [], intercept: (_name, _args, run) => run(),
    restart() { f.store = createStore(directory); stores.push(f.store); },
    async record() {
      const files = await readdir(join(directory, 'puzzles'));
      assert.equal(files.length, 1);
      return JSON.parse(await readFile(join(directory, 'puzzles', files[0]), 'utf8'));
    },
    async seed(events) {
      let result = await f.store.open(identity, payload);
      for (const event of events) result = await f.store.act({ identity, payload, lease: result.lease, revision: result.revision, event });
      return result;
    },
    mount({ answer = { status: 'empty' }, active = true, realBoard = false } = {}) {
      const container = dom.window.document.createElement('div');
      dom.window.document.body.append(container);
      const controller = new AbortController();
      const contextController = new AbortController();
      const changes = [];
      const board = { sets: [], destroyed: 0, set(value) { this.sets.push(value); }, destroy() { this.destroyed++; } };
      const ctx = {
        signal: contextController.signal,
        call(name, args) {
          f.calls.push({ name, args: structuredClone(args) });
          const run = () => {
            if (name === 'open-puzzle') return f.store.open(args.identity, args.payload);
            if (name === 'act-puzzle') return f.store.act(args);
            throw new Error(`Unexpected frontend call: ${name}`);
          };
          return f.intercept(name, args, run);
        },
      };
      const props = { ...identity, variant: 'probe', input: { question: 'Find the best move.', payload }, signal: controller.signal, active, answer, onChange(value) { changes.push(structuredClone(value)); } };
      const factory = (_element, config) => { board.config = config; return board; };
      const handle = realBoard ? mountEditor(ctx, container, props) : mountEditor(ctx, container, props, factory);
      handles.push(handle);
      const m = {
        container, controller, contextController, changes, board, handle, props,
        get field() { return container.querySelector('input'); },
        get status() { return container.querySelector('[role="status"]')?.textContent; },
        get last() { return changes.at(-1); },
        get config() { return board.sets.at(-1); },
        button(text) { const result = [...container.querySelectorAll('button')].find(button => button.textContent === text); assert.ok(result, `Button ${text}`); return result; },
        play(uci) { m.field.value = uci; m.button('Play move').click(); },
        after(from, to) { board.config.movable.events.after(from, to); },
        async settled() { await until(() => m.status && !/Loading|Saving/.test(m.status), 'editor settlement'); },
      };
      return m;
    },
  };
  f.restart();
  t.after(async () => {
    for (const handle of handles) handle.dispose();
    for (const store of stores) await store.dispose();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  return f;
}

test('async restore ignores stale mount/update drafts, writes nothing and only then publishes ready', async t => {
  const f = await fixture(t);
  const saved = await f.seed([move('d2d4'), { type: 'hint' }, move('e2e4'), move('g1f3')]);
  await f.store.dispose(); f.restart();
  const before = await f.record();
  const gate = deferred();
  f.intercept = async (_name, _args, run) => { const result = await run(); await gate.promise; return result; };
  const stale = { status: 'ready', value: initialState() };
  const m = f.mount({ answer: stale });
  assert.equal(m.last.status, 'unready');
  assert.equal(m.field.disabled, true);
  assert.equal(m.config.movable.dests.size, 0);
  m.handle.update({ answer: stale, active: true });
  assert.ok(m.changes.every(change => change.status === 'unready'));
  gate.resolve(); await m.settled();
  assert.deepEqual(m.last, { status: 'ready', value: saved.state });
  assert.deepEqual(f.calls.map(call => call.name), ['open-puzzle']);
  assert.deepEqual(await f.record(), before);
  assert.match(m.container.textContent, /First private hint/);
  assert.doesNotMatch(m.container.textContent, /Second private hint|Private knight hint/);
});

test('folding keeps the board alive, disables every move path and never writes or echoes updates', async t => {
  const f = await fixture(t);
  const m = f.mount(); await m.settled();
  m.handle.focus(); assert.equal(f.dom.window.document.activeElement, m.field);
  const changes = m.changes.length;
  m.handle.update({ active: false, answer: m.last });
  assert.equal(m.field.disabled, true);
  assert.equal(m.config.movable.color, undefined);
  assert.equal(m.config.movable.dests.size, 0);
  assert.equal(m.config.draggable.enabled, false);
  assert.equal(m.config.selectable.enabled, false);
  m.after('e2', 'e4'); m.play('e2e4'); m.button('?').click();
  m.container.querySelector('section').dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true }));
  assert.equal(m.handle.handleKeyDown('Enter'), 'pass');
  assert.equal(m.changes.length, changes);
  assert.equal(f.calls.length, 1);
  assert.equal(m.board.destroyed, 0);
  m.handle.update({ active: true, answer: m.last });
  assert.equal(m.field.disabled, false);
  assert.equal(m.config.movable.color, 'white');
  assert.deepEqual(m.config.movable.dests.get('e2'), ['e3', 'e4']);
  assert.equal(m.changes.length, changes);
  assert.equal((await f.record()).revision, 0);
});

test('controlled identical and changed answers render without onChange echo or backend writes', async t => {
  const f = await fixture(t);
  const m = f.mount(); await m.settled();
  const changes = m.changes.length;
  m.field.value = 'e2e'; m.field.setSelectionRange(1, 2);
  m.handle.update({ active: true, answer: m.last });
  assert.equal(m.field.value, 'e2e'); assert.equal(m.field.selectionStart, 1); assert.equal(m.field.selectionEnd, 2);
  const changed = { ...initialState(), moves: ['e2e4', 'e7e5'], revealedHints: [{ learnerMove: 0, count: 1 }] };
  m.handle.update({ answer: { status: 'unready', value: changed } });
  assert.match(m.container.textContent, /Moves: e2e4 e7e5/);
  assert.match(m.container.textContent, /First private hint/);
  assert.deepEqual(m.config.lastMove, ['e7', 'e5']);
  assert.equal(m.changes.length, changes);
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.record()).state, initialState());
});

for (const phase of ['load', 'act']) {
  for (const disposal of ['dispose', 'props abort', 'context abort']) {
    test(`${disposal} destroys board once and fences late ${phase} response and stale callbacks`, async t => {
      const f = await fixture(t);
      const gate = deferred();
      let committed = false;
      f.intercept = async (name, _args, run) => {
        const result = await run();
        if (name === (phase === 'load' ? 'open-puzzle' : 'act-puzzle')) { committed = true; await gate.promise; }
        return result;
      };
      const m = f.mount();
      if (phase === 'act') { await m.settled(); m.play('e2e4'); }
      await until(() => committed, 'real operation before delayed delivery');
      if (disposal === 'dispose') m.handle.dispose();
      else if (disposal === 'props abort') m.controller.abort();
      else m.contextController.abort();
      const changes = m.changes.length, sets = m.board.sets.length, calls = f.calls.length;
      m.handle.dispose();
      gate.resolve(); await delay(20);
      m.after('e2', 'e4'); m.handle.focus(); m.handle.update({ active: true, answer: { status: 'empty' } });
      assert.equal(m.handle.handleKeyDown('Enter'), 'pass');
      assert.equal(m.board.destroyed, 1);
      assert.equal(m.container.childElementCount, 0);
      assert.equal(m.changes.length, changes); assert.equal(m.board.sets.length, sets); assert.equal(f.calls.length, calls);
      assert.equal((await f.record()).revision, phase === 'act' ? 1 : 0);
    });
  }
}

test('load errors fail closed and explicit reload restores the actual saved snapshot', async t => {
  const f = await fixture(t);
  await f.seed([move('e2e4')]);
  let fail = true;
  f.intercept = (name, _args, run) => name === 'open-puzzle' && fail ? Promise.reject(new Error('Offline')) : run();
  const m = f.mount(); await m.settled();
  assert.match(m.status, /Could not load saved progress: Offline/);
  assert.equal(m.last.status, 'unready'); assert.equal(m.field.disabled, true);
  m.after('e2', 'e4'); assert.equal(f.calls.length, 1);
  assert.equal(m.button('Reload saved progress').hidden, false);
  fail = false; m.button('Reload saved progress').click(); await m.settled();
  assert.deepEqual(m.last.value.moves, ['e2e4', 'e7e5']);
  assert.equal(m.button('Reload saved progress').hidden, true);
  assert.equal((await f.record()).revision, 1);
});

test('uncertain committed act blocks replay until reload, then continues at the saved revision', async t => {
  const f = await fixture(t);
  let loseResponse = true;
  f.intercept = async (name, _args, run) => {
    const result = await run();
    if (name === 'act-puzzle' && loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
    return result;
  };
  const m = f.mount(); await m.settled();
  m.play('e2e4'); await m.settled();
  assert.match(m.status, /Progress could not be confirmed.*Reload saved progress/);
  assert.equal(m.last.status, 'unready'); assert.deepEqual(m.last.value.moves, []);
  assert.deepEqual((await f.record()).state.moves, ['e2e4', 'e7e5']);
  m.after('e2', 'e4'); m.play('e2e4'); assert.equal(f.calls.length, 2);
  m.button('Reload saved progress').click(); await m.settled();
  assert.deepEqual(m.last.value.moves, ['e2e4', 'e7e5']);
  m.play('g1f3'); await m.settled();
  assert.equal(m.last.status, 'ready');
  assert.equal(f.calls.at(-1).args.revision, 1);
  assert.equal((await f.record()).revision, 2);
  assert.deepEqual((await f.record()).state.incorrectAttempts, []);
});

test('legal unauthored board move gets neutral feedback and records a retry without advancing the position', async t => {
  const f = await fixture(t);
  const m = f.mount(); await m.settled();
  const fen = m.config.fen;
  m.after('d2', 'd4');
  assert.equal(m.status, 'That legal move is not included in the authored puzzle lines. Its chess quality has not been established. Try another move. Saving progress…');
  await m.settled();
  assert.equal(m.status, 'That legal move is not included in the authored puzzle lines. Its chess quality has not been established. Try another move.');
  assert.match(m.container.textContent, /Recorded retries: 1/);
  assert.doesNotMatch(m.container.textContent, /Incorrect attempts|Wrong|Mistake/);
  assert.equal(m.config.fen, fen); assert.deepEqual(m.config.lastMove, []);
  assert.deepEqual(m.last.value.incorrectAttempts, [{ atPly: 0, move: 'd2d4' }]);
  m.play('e2e5'); await m.settled();
  assert.match(m.status, /Illegal move/); assert.equal(m.field.value, 'e2e5');
  m.after('e2', 'e4'); await m.settled();
  assert.deepEqual(m.last.value.moves, ['e2e4', 'e7e5']);
  assert.deepEqual(m.last.value.incorrectAttempts, [{ atPly: 0, move: 'd2d4' }, { atPly: 0, move: 'e2e5' }]);
  assert.deepEqual((await f.record()).state, m.last.value);
});

test('hints require explicit requests, advance progressively and survive learner moves and restart', async t => {
  const f = await fixture(t);
  const m = f.mount(); await m.settled();
  assert.equal(m.container.querySelectorAll('.chess-training-hints li').length, 0);
  assert.doesNotMatch(m.container.textContent, /private hint|Private knight hint|e7e5|g1f3/);
  m.field.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true }));
  assert.equal(f.calls.length, 1);
  m.button('?').click(); await m.settled();
  assert.match(m.container.textContent, /First private hint/); assert.doesNotMatch(m.container.textContent, /Second private hint/);
  m.container.querySelector('section').dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true }));
  await m.settled(); assert.equal(m.button('?').disabled, true);
  assert.equal(m.container.querySelectorAll('.chess-training-hints li').length, 2);
  m.play('e2e4'); await m.settled();
  assert.equal(m.button('?').disabled, false);
  assert.match(m.container.textContent, /First private hint/); assert.doesNotMatch(m.container.textContent, /Private knight hint/);
  m.button('?').click(); await m.settled();
  const saved = structuredClone(m.last.value);
  m.handle.dispose(); await f.store.dispose(); f.restart();
  const restored = f.mount(); await restored.settled();
  assert.deepEqual(restored.last.value, saved);
  assert.equal(restored.container.querySelectorAll('.chess-training-hints li').length, 3);
  assert.equal((await f.record()).revision, 4);
});

test('completion publishes ready only after the durable act response; Enter edits and never submits', async t => {
  const f = await fixture(t);
  const m = f.mount(); await m.settled(); m.play('e2e4'); await m.settled();
  const gate = deferred(); let committed = false;
  f.intercept = async (_name, _args, run) => { const result = await run(); committed = true; await gate.promise; return result; };
  m.handle.focus(); m.field.value = 'g1f3';
  assert.equal(m.handle.handleKeyDown('Enter'), 'handled');
  await until(() => committed, 'durable final move');
  assert.equal(m.last.status, 'unready'); assert.equal(m.field.disabled, true);
  assert.deepEqual((await f.record()).state.moves, ['e2e4', 'e7e5', 'g1f3']);
  assert.ok(m.changes.every(change => change.status !== 'ready'));
  gate.resolve(); await m.settled();
  assert.equal(m.last.status, 'ready'); assert.equal(m.field.value, '');
  assert.match(m.status, /normal Submit button/);
  assert.equal(m.config.movable.dests.size, 0);
  const calls = f.calls.length;
  m.after('b1', 'c3'); m.button('?').click(); m.handle.handleKeyDown('Enter');
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.calls.map(call => call.name), ['open-puzzle', 'act-puzzle', 'act-puzzle']);
});

for (const [piece, label] of [['q', 'Queen'], ['r', 'Rook'], ['b', 'Bishop'], ['n', 'Knight']]) {
  test(`board promotion explicitly chooses ${label}, never defaults to queen`, async t => {
    const payload = { fen: '7k/P7/8/8/8/8/8/7K w - - 0 1', lines: [[`a7a8${piece}`]], hints: [['Promotion hint']] };
    const f = await fixture(t, payload);
    const m = f.mount(); await m.settled();
    m.after('a7', 'a8');
    assert.equal(f.calls.length, 1); assert.equal(m.field.disabled, true);
    assert.equal(m.container.querySelector('[aria-label="Choose promotion piece"]').hidden, false);
    assert.deepEqual([...m.container.querySelectorAll('.chess-training-promotion button')].map(button => button.textContent), ['Queen', 'Rook', 'Bishop', 'Knight']);
    assert.equal(m.config.movable.dests.size, 0);
    assert.equal(m.handle.handleKeyDown('Escape'), 'handled');
    assert.equal(f.calls.length, 1); assert.equal(m.field.disabled, false);
    m.after('a7', 'a8'); m.button(label).click(); await m.settled();
    assert.equal(f.calls.at(-1).args.event.uci, `a7a8${piece}`);
    assert.deepEqual(m.last.value.moves, [`a7a8${piece}`]); assert.equal(m.last.status, 'ready');
    assert.deepEqual((await f.record()).state, m.last.value);
  });
}

test('UCI underpromotion is explicit too; missing suffix is an illegal recorded attempt', async t => {
  const f = await fixture(t, { fen: '7k/P7/8/8/8/8/8/7K w - - 0 1', lines: [['a7a8n']], hints: [['Private promotion hint']] });
  const m = f.mount(); await m.settled();
  m.play('a7a8'); await m.settled(); assert.match(m.status, /Illegal move/);
  m.play('a7a8n'); await m.settled();
  assert.equal(m.last.status, 'ready'); assert.deepEqual(m.last.value.incorrectAttempts, [{ atPly: 0, move: 'a7a8' }]);
});

for (const [name, payload, from, to, orientation] of [
  ['black', { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1', lines: [['e7e5']], hints: [['Black hint']] }, 'e7', 'e5', 'black'],
  ['castling', { fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', lines: [['e1g1']], hints: [['Castle hint']] }, 'e1', 'g1', 'white'],
  ['en passant', { fen: '7k/8/8/3pP3/8/8/8/7K w - d6 0 2', lines: [['e5d6']], hints: [['Capture hint']] }, 'e5', 'd6', 'white'],
]) {
  test(`${name} board exposes legal destinations and saves standard UCI`, async t => {
    const f = await fixture(t, payload);
    const m = f.mount(); await m.settled();
    assert.equal(m.board.config.orientation, orientation);
    assert.equal(m.config.movable.color, orientation);
    assert.ok(m.config.movable.dests.get(from).includes(to));
    assert.equal(m.config.movable.dests.has(orientation === 'black' ? 'e2' : 'e8'), false);
    assert.equal(m.board.config.movable.free, false); assert.equal(m.board.config.movable.rookCastle, false);
    m.after(from, to); await m.settled();
    assert.deepEqual(m.last.value.moves, [from + to]); assert.equal(m.last.status, 'ready');
    assert.deepEqual((await f.record()).state, m.last.value);
  });
}

test('public registration uses native Markdown fallback; answered rendering shows only learner evidence and revealed hints', async t => {
  const f = await fixture(t);
  let renderer;
  let unregistered = 0;
  const toolRenderers = new Map();
  let lessonUnregistered = 0;
  const unregister = activate({
    signal: new AbortController().signal,
    registerToolRenderer(value) { toolRenderers.set(value.toolName, value); return () => lessonUnregistered++; },
    registerQuestionRenderer(value) { renderer = value; return () => unregistered++; },
  });
  assert.deepEqual([...toolRenderers.keys()].sort(), ['chess_training_find_puzzles', 'chess_training_lesson']);
  assert.equal(renderer.id, 'puzzle'); assert.deepEqual(renderer.supportedContractVersions, [1]);
  assert.equal(Object.hasOwn(renderer, 'mountQuestion'), false);
  assert.equal(typeof renderer.mountAnswerEditor, 'function');
  const container = f.dom.window.document.createElement('div');
  const props = { ...identity, variant: 'probe', signal: new AbortController().signal, input: { question: 'Public Markdown only', payload: f.payload }, answer: { moves: [], incorrectAttempts: [{ atPly: 0, move: '<b>d2d4</b>' }], revealedHints: [{ learnerMove: 0, count: 1 }] } };
  const dispose = renderer.mountAnswered(container, props);
  assert.match(container.textContent, /Recorded retries: 1/); assert.match(container.textContent, /Ply 1: <b>d2d4<\/b>/);
  assert.doesNotMatch(container.textContent, /Incorrect attempts|Wrong|Mistake/);
  assert.match(container.textContent, /First private hint/);
  assert.doesNotMatch(container.textContent, /Second private hint|Private knight hint|e2e4|e7e5|g1f3/);
  assert.equal(container.querySelector('b'), null);
  dispose(); assert.equal(container.childElementCount, 0);
  // Historical answers are format-only, not regraded against today's solution.
  renderer.mountAnswered(container, { ...props, answer: { moves: ['d2d4'], incorrectAttempts: [], revealedHints: [] } });
  assert.match(container.textContent, /Moves: d2d4/);
  assert.doesNotMatch(container.textContent, /private hint|Private knight hint|e2e4|g1f3/);
  unregister(); unregister(); assert.equal(unregistered, 1); assert.equal(lessonUnregistered, 2);
});

test('real Chessground mounts, restores, accepts a UCI move and disposes in jsdom', async t => {
  const f = await fixture(t);
  const m = f.mount({ realBoard: true }); await m.settled();
  assert.ok(m.container.querySelector('cg-board'));
  assert.ok(m.container.querySelector('.orientation-white'));
  assert.equal(m.container.querySelectorAll('cg-board piece').length, 32);
  m.play('e2e4'); await m.settled();
  await delay(30); // allow Chessground's actual requestAnimationFrame redraw
  assert.deepEqual(m.last.value.moves, ['e2e4', 'e7e5']);
  const pieces = [...m.container.querySelectorAll('cg-board piece')];
  assert.ok(pieces.some(piece => piece.cgKey === 'e4' && piece.classList.contains('white')));
  assert.ok(pieces.some(piece => piece.cgKey === 'e5' && piece.classList.contains('black')));
  m.handle.dispose(); assert.equal(m.container.childElementCount, 0);
});

for (const black of [false, true]) test(`answered replay is read-only, lazy and navigates actual ${black ? 'black promotion' : 'white'} moves`, async t => {
  const f = await fixture(t);
  const container = f.dom.window.document.createElement('div'); f.dom.window.document.body.append(container);
  const controller = new AbortController();
  const answer = { moves: black ? ['a2a1n'] : ['e2e4', 'e7e5', 'g1f3'], incorrectAttempts: [], revealedHints: [] };
  const payload = black ? { ...f.payload, fen: '7k/8/8/8/8/8/p7/7K b - - 0 1' } : f.payload;
  const before = structuredClone(answer);
  const boards = [];
  const dispose = mountReplay({ signal: new AbortController().signal }, container,
    { input: { payload }, answer, signal: controller.signal }, (_element, config) => {
      const board = { config, sets: [], destroyed: 0, set(value) { this.sets.push(value); }, destroy() { this.destroyed++; } };
      boards.push(board); return board;
    });
  const toggle = container.querySelector('button');
  const [back, next] = container.querySelectorAll('section button');
  assert.equal(boards.length, 0); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click(); const board = boards[0];
  assert.equal(board.config.orientation, black ? 'black' : 'white'); assert.equal(board.config.viewOnly, true);
  assert.equal(board.config.draggable.enabled, false); assert.equal(board.config.selectable.enabled, false);
  assert.equal(board.config.movable.dests.size, 0); assert.equal(next.disabled, true);
  assert.match(container.querySelector('[role="status"]').textContent, new RegExp(`Move ${answer.moves.length} of ${answer.moves.length}`));
  for (let i = answer.moves.length; i > 0; i--) back.click();
  assert.equal(back.disabled, true); assert.match(container.textContent, /starting position/);
  assert.equal(board.sets.at(-1).lastMove, undefined);
  for (let i = 0; i < answer.moves.length; i++) next.click();
  assert.equal(next.disabled, true); assert.deepEqual(answer, before);
  assert.equal(f.calls.length, 0); assert.doesNotMatch(container.textContent, /private hint|Private knight hint/);
  toggle.click(); assert.equal(board.destroyed, 1); assert.equal(container.querySelector('section').hidden, true);
  toggle.click(); assert.equal(boards.length, 2);
  controller.abort(); dispose(); dispose(); assert.equal(boards[1].destroyed, 1); assert.equal(container.childElementCount, 0);
});

test('unplayable historical answer falls back without exposing authored solutions', async t => {
  const f = await fixture(t);
  const container = f.dom.window.document.createElement('div');
  const dispose = mountReplay({ signal: new AbortController().signal }, container,
    { input: { payload: f.payload }, answer: { moves: ['e2e5'] }, signal: new AbortController().signal }, () => { throw new Error('Must not mount'); });
  assert.match(container.textContent, /Replay unavailable/); assert.equal(container.querySelector('button'), null);
  assert.doesNotMatch(container.textContent, /e2e4|e7e5|private hint/); dispose(); assert.equal(container.childElementCount, 0);
});
