import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountLesson } from '../src/lesson.js';

const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const lesson = () => ({ version: 1, title: '<b>Lesson</b>', explanation: 'Public explanation', fen, orientation: 'white',
  annotations: { explanation: 'Root explanation', arrows: [{ from: 'e2', to: 'e4', color: 'green' }], circles: [{ square: 'd4', color: 'red' }], highlights: [{ square: 'e4', color: 'blue' }] },
  variations: [{ name: 'King pawn', moves: ['e2e4', 'e7e5'], annotations: [{ ply: 1, explanation: 'After e4', arrows: [{ from: 'e7', to: 'e5', color: 'yellow' }] }] }, { name: 'Queen pawn', moves: ['d2d4', 'd7d5'] }],
});
function fixture(t) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const previous = globalThis.AbortController;
  globalThis.AbortController = dom.window.AbortController;
  const handles = [];
  t.after(() => { handles.forEach(h => h.dispose()); globalThis.AbortController = previous; dom.window.close(); });
  return function mount(output = lesson(), state = 'output-available', initiallyAborted = false) {
    const container = dom.window.document.createElement('div'); dom.window.document.body.append(container);
    const signal = new AbortController(); const context = new AbortController();
    if (initiallyAborted) signal.abort();
    const board = { sets: [], destroyed: 0, set(config) { this.sets.push(config); }, destroy() { this.destroyed++; } };
    const ctx = { signal: context.signal, call() { assert.fail('Lesson must never call backend'); } };
    const dispose = mountLesson(ctx, container, { input: { invalid: true }, output, toolCallId: 'same-id', state, signal: signal.signal }, (_el, config) => { board.initial = config; return board; });
    const m = { dispose, container, board, signal, context, dom,
      get config() { return board.sets.at(-1); },
      get field() { return container.querySelector('input'); },
      button(text) { return [...container.querySelectorAll('button')].find(b => b.textContent === text); },
      play(uci) { this.field.value = uci; this.button('Play move').click(); },
      choose(index) { const select = container.querySelector('select'); select.value = String(index); select.dispatchEvent(new dom.window.Event('change')); },
      after(from, to) { board.initial.movable.events.after(from, to); },
    };
    handles.push(m); return m;
  };
}
test('lesson renders direct output safely, root markings, legal destinations and no submission API', t => {
  const mount = fixture(t); const original = lesson(); const before = structuredClone(original); const m = mount(original);
  assert.match(m.container.textContent, /Public explanation.*memory-only/s);
  assert.match(m.container.textContent, /Root explanation/); assert.equal(m.container.querySelector('b'), null);
  assert.equal(m.config.movable.color, 'white'); assert.deepEqual(m.config.movable.dests.get('e2'), ['e3', 'e4']);
  assert.deepEqual(m.config.drawable.autoShapes, [{ orig: 'e2', dest: 'e4', brush: 'green' }, { orig: 'd4', brush: 'red' }]);
  assert.equal(m.config.highlight.custom.get('e4'), 'chess-training-highlight-blue');
  m.play('e2e5'); assert.match(m.container.textContent, /Illegal/i); assert.equal(m.config.fen, fen);
  m.play('e2e4'); assert.equal(m.config.movable.color, 'black'); assert.equal(m.config.lastMove.join(''), 'e2e4');
  assert.doesNotMatch(m.container.textContent, /Root explanation/); assert.equal(m.config.drawable.autoShapes.length, 0);
  m.play('e7e5'); assert.equal(m.config.movable.color, 'white'); m.button('Undo').click(); assert.equal(m.config.movable.color, 'black');
  m.button('Reset').click(); assert.equal(m.config.fen, fen); assert.match(m.container.textContent, /Root explanation/);
  assert.deepEqual(original, before);
});
test('occurrences are independent; navigation replaces branches, uses absolute ply and clears markings', t => {
  const mount = fixture(t); const a = mount(); const b = mount();
  a.choose(0); a.button('Next ply').click(); assert.match(a.container.textContent, /After e4/);
  assert.deepEqual(a.config.drawable.autoShapes, [{ orig: 'e7', dest: 'e5', brush: 'yellow' }]);
  assert.equal(b.config.fen, fen); assert.match(b.container.textContent, /Root explanation/);
  a.button('Next ply').click(); assert.match(a.container.textContent, /Moves: e2e4 e7e5/);
  a.button('Previous ply').click(); assert.match(a.container.textContent, /Moves: e2e4/);
  a.choose(1); assert.equal(a.config.fen, fen); a.button('Next ply').click(); assert.match(a.container.textContent, /Moves: d2d4/);
  assert.doesNotMatch(a.container.textContent, /After e4/); assert.equal(a.config.drawable.autoShapes.length, 0);
  a.play('g8f6'); assert.match(a.container.textContent, /Free exploration/);
  a.button('Reset').click(); assert.match(a.container.textContent, /Root explanation/);
});
for (const [piece, name] of [['q', 'Queen'], ['r', 'Rook'], ['b', 'Bishop'], ['n', 'Knight']]) {
  test(`explicit board promotion to ${name}, keyboard underpromotion, Escape and reset`, t => {
    const mount = fixture(t); const m = mount({ version: 1, title: 'Promotion', explanation: 'Choose a piece', orientation: 'white', fen: '7k/P7/8/8/8/8/8/7K w - - 0 1', variations: [] });
    m.after('a7', 'a8'); assert.equal(m.field.disabled, true); assert.match(m.container.textContent, /Choose a promotion piece/);
    m.container.querySelector('section').dispatchEvent(new m.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(m.field.disabled, false); m.after('a7', 'a8'); m.button(name).click(); assert.match(m.container.textContent, new RegExp(`Moves: a7a8${piece}`));
    m.button('Reset').click(); m.field.value = 'a7a8n';
    const enter = new m.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); m.field.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true); assert.match(m.container.textContent, /Moves: a7a8n/);
  });
}
for (const [name, start, from, to, turn] of [
  ['black', fen.replace(' w ', ' b '), 'e7', 'e5', 'black'],
  ['castling', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1', 'g1', 'white'],
  ['en passant', '7k/8/8/3pP3/8/8/8/7K w - d6 0 2', 'e5', 'd6', 'white'],
]) test(`${name} exposes legal destinations and accepts standard board UCI`, t => {
  const mount = fixture(t); const m = mount({ version: 1, title: name, explanation: name, orientation: 'black', fen: start, variations: [] });
  assert.equal(m.board.initial.orientation, 'black'); assert.equal(m.config.movable.color, turn);
  assert.ok(m.config.movable.dests.get(from).includes(to));
  m.after(from, to); assert.match(m.container.textContent, new RegExp(`Moves: ${from}${to}`));
  assert.equal(m.config.movable.color, turn === 'white' ? 'black' : 'white');
});
for (const method of ['dispose', 'signal', 'context']) test(`${method} destroys once and fences stale callbacks`, t => {
  const mount = fixture(t); const m = mount();
  if (method === 'dispose') m.dispose(); else m[method].abort();
  const sets = m.board.sets.length;
  m.dispose(); m.after('e2', 'e4');
  assert.equal(m.board.destroyed, 1); assert.equal(m.board.sets.length, sets); assert.equal(m.container.childElementCount, 0);
});
test('keyboard UCI owns only plain non-composing Enter inside its own field', t => {
  const mount = fixture(t); const m = mount(); m.field.value = 'e2e4';
  for (const modifiers of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    const event = new m.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers });
    m.field.dispatchEvent(event); assert.equal(event.defaultPrevented, false); assert.equal(m.config.fen, fen);
  }
  const outside = new m.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  m.container.querySelector('section').dispatchEvent(outside); assert.equal(outside.defaultPrevented, false); assert.equal(m.config.fen, fen);
});
test('streaming, errors and malformed output never create a board; pre-abort creates no DOM', t => {
  const mount = fixture(t);
  for (const state of ['input-streaming', 'input-available', 'output-error']) {
    const m = mount(lesson(), state); assert.equal(m.board.initial, undefined); m.signal.abort(); assert.equal(m.container.childElementCount, 0);
  }
  const malformed = mount({ lesson: lesson() }); assert.match(malformed.container.textContent, /Lesson unavailable/); assert.equal(malformed.board.initial, undefined);
  const aborted = mount(lesson(), 'output-available', true); assert.equal(aborted.container.childElementCount, 0); assert.equal(aborted.board.initial, undefined);
});
