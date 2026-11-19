import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSquare } from 'chessops/util';
import { lessonSchema, validateLesson, createLessonController } from '../src/lesson-core.js';
import { startPosition } from '../src/core.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const lesson = (overrides = {}) => ({
  version: 1, title: ' Central play ', explanation: ' Explore the centre. ',
  fen: START, orientation: 'white', variations: [
    { name: 'Open game', moves: ['e2e4', 'e7e5', 'g1f3'] },
    { name: 'Queen pawn', moves: ['d2d4', 'd7d5'] },
  ], ...overrides,
});
const marks = (explanation) => ({
  explanation,
  arrows: [{ from: 'e2', to: 'e4', color: 'green' }],
  circles: [{ square: 'd4', color: 'blue' }],
  highlights: [{ square: 'e4', color: 'yellow' }, { square: 'd5', color: 'red' }],
});
const emptyMarks = { arrows: [], circles: [], highlights: [] };
const piece = (snapshot, square) => startPosition(snapshot.fen).board.get(parseSquare(square));
const deeplyFrozen = value => {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    Object.values(value).forEach(deeplyFrozen);
  }
};

// Interpret only the JSON Schema vocabulary used by this standalone public contract.
// Chess legality, nonblank text, unique names and annotation bounds are refinements.
function schemaAccepts(schema, value) {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) =>
      schema.properties[key] ? schemaAccepts(schema.properties[key], item) : schema.additionalProperties !== false);
  }
  if (schema.type === 'array') return Array.isArray(value) && value.every(item => schemaAccepts(schema.items, item));
  if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity))) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  return !schema.enum || schema.enum.includes(value);
}

test('v1 schema is JSON-only and shares exact root, variation and annotation fields with validation', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(lessonSchema)), lessonSchema);
  assert.equal(lessonSchema.additionalProperties, false);
  assert.deepEqual(lessonSchema.required, ['version', 'title', 'explanation', 'fen', 'orientation', 'variations']);
  const payload = lesson({ annotations: marks(' Root '), variations: [
    { name: 'Annotated', moves: ['e2e4', 'e7e5'], annotations: [
      { ply: 0, ...marks(' At start ') }, { ply: 2, ...marks(' After reply ') },
    ] },
  ] });
  const valid = [payload, lesson({ variations: [] }), lesson({ orientation: 'black', annotations: {}, variations: [{ name: 'Empty', moves: [], annotations: [{ ply: 0 }] }] })];
  for (const input of valid) {
    assert.equal(schemaAccepts(lessonSchema, input), true);
    assert.doesNotThrow(() => validateLesson(input));
  }
  // Every declared field is supplied above, and undeclared fields fail at every level.
  for (const path of [[], ['annotations'], ['annotations', 'arrows', 0], ['annotations', 'circles', 0], ['annotations', 'highlights', 0], ['variations', 0], ['variations', 0, 'annotations', 0]]) {
    const input = structuredClone(payload);
    let target = input;
    for (const key of path) target = target[key];
    target.extra = 'not allowed';
    assert.equal(schemaAccepts(lessonSchema, input), false, path.join('.'));
    assert.throws(() => validateLesson(input), /allowed fields/);
  }
  for (const key of lessonSchema.required) {
    const input = lesson(); delete input[key];
    assert.equal(schemaAccepts(lessonSchema, input), false);
    assert.throws(() => validateLesson(input), /requires/);
  }
});

test('every variation is independently validated from the same FEN; odd, even and empty lengths are allowed', () => {
  const payload = lesson();
  assert.doesNotThrow(() => validateLesson(payload));
  assert.doesNotThrow(() => validateLesson(lesson({ variations: [{ name: 'Start', moves: [] }] })));
  payload.variations.push({ name: 'Bad late branch', moves: ['c2c4', 'e7e5', 'c4c6'] });
  assert.throws(() => validateLesson(payload), /Variation 3, ply 3: illegal standard UCI move c4c6/);
});

test('six-field standard FEN preserves initial text, black turn and independent orientation', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const controller = createLessonController(lesson({ fen, orientation: 'white', variations: [{ name: 'Black reply', moves: ['e7e5', 'g1f3'] }] }));
  assert.equal(controller.snapshot().fen, fen);
  assert.equal(controller.snapshot().turn, 'black');
  const after = controller.selectVariation(0, 2);
  assert.equal(after.turn, 'black');
  assert.equal(piece(after, 'f3').role, 'knight');
  assert.equal(controller.reset().fen, fen);
});

for (const [fen, move, king, rook] of [
  ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1', 'g1', 'f1'],
  ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1c1', 'c1', 'd1'],
  ['r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'e8g8', 'g8', 'f8'],
  ['r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'e8c8', 'c8', 'd8'],
]) test(`king-destination castling ${move} moves both pieces and undoes exactly`, () => {
  const controller = createLessonController(lesson({ fen, variations: [{ name: 'Castle', moves: [move] }] }));
  const authored = controller.selectVariation(0, 1);
  assert.equal(piece(authored, king).role, 'king');
  assert.equal(piece(authored, rook).role, 'rook');
  assert.deepEqual(authored.moves, [move]);
  controller.reset();
  assert.equal(controller.move(move).fen, authored.fen);
  assert.equal(controller.undo().fen, fen);
});

test('en passant removes the captured pawn and undo/reset restore the target', () => {
  const fen = '7k/8/8/3pP3/8/8/8/7K w - d6 0 2';
  const controller = createLessonController(lesson({ fen, variations: [{ name: 'Capture', moves: ['e5d6'] }] }));
  const authored = controller.selectVariation(0, 1);
  assert.equal(piece(authored, 'd5'), undefined);
  assert.equal(piece(authored, 'e5'), undefined);
  assert.equal(piece(authored, 'd6').role, 'pawn');
  assert.equal(controller.undo().fen, fen);
  assert.equal(controller.move('e5d6').fen, authored.fen);
  assert.equal(controller.reset().fen, fen);
});

for (const [suffix, role] of [['q', 'queen'], ['r', 'rook'], ['b', 'bishop'], ['n', 'knight']]) {
  test(`explicit ${role} promotion works in authored and free play`, () => {
    const fen = '7k/P7/8/8/8/8/8/7K w - - 0 1';
    const controller = createLessonController(lesson({ fen, variations: [{ name: 'Promote', moves: [`a7a8${suffix}`] }] }));
    assert.throws(() => controller.move('a7a8'), /Illegal move/);
    const authored = controller.selectVariation(0, 1);
    assert.equal(piece(authored, 'a8').role, role);
    controller.reset();
    assert.equal(controller.move(`a7a8${suffix}`).fen, authored.fen);
    assert.equal(controller.undo().fen, fen);
  });
}

test('free moves are not puzzle acceptance, never auto-reply, and undo/reset are bounded', () => {
  const controller = createLessonController(lesson());
  assert.deepEqual(controller.undo(), controller.snapshot());
  const first = controller.move('c2c4');
  assert.deepEqual(first.moves, ['c2c4']);
  assert.equal(first.turn, 'black');
  assert.equal(first.variation, null);
  controller.move('e7e5');
  assert.deepEqual(controller.undo(), first);
  assert.equal(controller.undo().fen, START);
  assert.equal(controller.reset().ply, 0);
  assert.throws(() => controller.step(0), /Choose an authored variation/);
});

test('selecting another variation replaces the entire path rather than extending exploration', () => {
  const controller = createLessonController(lesson());
  controller.move('c2c4');
  assert.deepEqual(controller.selectVariation(0).moves, []);
  assert.deepEqual(controller.step(3).moves, ['e2e4', 'e7e5', 'g1f3']);
  const replacement = controller.selectVariation(1, 2);
  assert.deepEqual(replacement.moves, ['d2d4', 'd7d5']);
  assert.equal(piece(replacement, 'e4'), undefined);
  assert.equal(controller.undo().variation, 1);
  assert.deepEqual(controller.step(0).moves, []);
  assert.equal(controller.reset().variation, null);
});

test('annotations apply at exact root/variation plies, replace rather than merge, and clear on free branches', () => {
  const controller = createLessonController(lesson({ annotations: marks('Root'), variations: [
    { name: 'Marked', moves: ['e2e4', 'e7e5', 'g1f3'], annotations: [
      { ply: 0, explanation: 'Variation start' }, { ply: 1, ...marks('After e4') },
    ] },
    { name: 'Unmarked', moves: ['d2d4', 'd7d5'] },
  ] }));
  assert.deepEqual(controller.snapshot().annotations, marks('Root'));
  assert.deepEqual(controller.selectVariation(0).annotations, { ...emptyMarks, explanation: 'Variation start' });
  assert.deepEqual(controller.step(1).annotations, marks('After e4'));
  assert.deepEqual(controller.step(2).annotations, emptyMarks);
  assert.deepEqual(controller.undo().annotations, marks('After e4'));
  const branch = controller.move('c7c5');
  assert.equal(branch.variation, null);
  assert.deepEqual(branch.annotations, emptyMarks);
  assert.throws(() => controller.step(3), /Choose an authored variation/);
  // Even playing an authored continuation is exploration, not implicit branch selection.
  controller.selectVariation(0, 1);
  assert.equal(controller.move('e7e5').variation, null);
  assert.deepEqual(controller.undo().annotations, emptyMarks);
  assert.deepEqual(controller.selectVariation(1, 0).annotations, marks('Root'));
  assert.deepEqual(controller.step(1).annotations, emptyMarks);
  assert.deepEqual(controller.reset().annotations, marks('Root'));
});

test('validation and controller snapshots detach and deeply freeze data without mutating callers', () => {
  const input = lesson({ annotations: marks(' Root '), variations: [{ name: 'Line', moves: ['e2e4'], annotations: [{ ply: 1, ...marks(' Move ') }] }] });
  const before = structuredClone(input);
  const validated = validateLesson(input);
  const controller = createLessonController(input);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input), false);
  assert.deepEqual(validated, before);
  deeplyFrozen(validated);
  input.annotations.arrows[0].to = 'e3';
  input.variations[0].moves[0] = 'd2d4';
  const first = controller.snapshot();
  deeplyFrozen(first);
  assert.equal(first.annotations.arrows[0].to, 'e4');
  assert.throws(() => first.moves.push('e2e4'), TypeError);
  assert.throws(() => { first.annotations.arrows[0].color = 'red'; }, TypeError);
  const selected = controller.selectVariation(0, 1);
  deeplyFrozen(selected);
  assert.deepEqual(selected.moves, ['e2e4']);
  assert.equal(selected.annotations.explanation, ' Move ');
  assert.equal(validated.title, ' Central play ');
  controller.reset();
  assert.deepEqual(first.moves, []);
  assert.deepEqual(selected.moves, ['e2e4']);
  assert.notEqual(controller.snapshot(), first);
  assert.notEqual(controller.snapshot().annotations, first.annotations);
  assert.equal(createLessonController(before).snapshot().ply, 0);
});

test('invalid controller actions fail atomically and retain the selected authored branch', () => {
  const controller = createLessonController(lesson());
  const before = controller.selectVariation(0, 1);
  const actions = [
    () => controller.move('e2e5'), () => controller.move('e7e5q'),
    ...[-1, 2, 0.5, '0', NaN, Infinity].map(index => () => controller.selectVariation(index)),
    ...[-1, 4, 0.5, '1', NaN, Infinity].flatMap(ply => [() => controller.selectVariation(0, ply), () => controller.step(ply)]),
  ];
  for (const action of actions) {
    assert.throws(action, /Illegal move|Unknown lesson variation|Variation ply is out of range/);
    assert.deepEqual(controller.snapshot(), before);
  }
});

const invalidShapes = [
  ['wrong version', { version: 2 }], ['blank title', { title: '' }],
  ['wrong explanation type', { explanation: 2 }], ['orientation', { orientation: 'auto' }],
  ['variation list', { variations: {} }], ['root annotation object', { annotations: [] }],
  ['root arrows', { annotations: { arrows: {} } }],
  ['mark color', { annotations: { circles: [{ square: 'e4', color: 'orange' }] } }],
  ['mark square', { annotations: { highlights: [{ square: 'e9', color: 'green' }] } }],
  ['missing mark field', { annotations: { arrows: [{ from: 'e2', color: 'green' }] } }],
  ['variation name', { variations: [{ name: '', moves: [] }] }],
  ['moves array', { variations: [{ name: 'Line', moves: 'e2e4' }] }],
  ['UCI shape', { variations: [{ name: 'Line', moves: ['e4'] }] }],
  ['variation annotations', { variations: [{ name: 'Line', moves: [], annotations: {} }] }],
  ['missing ply', { variations: [{ name: 'Line', moves: [], annotations: [{}] }] }],
  ['negative ply', { variations: [{ name: 'Line', moves: [], annotations: [{ ply: -1 }] }] }],
  ['fractional ply', { variations: [{ name: 'Line', moves: [], annotations: [{ ply: 0.5 }] }] }],
];
for (const [label, overrides] of invalidShapes) test(`schema/runtime reject ${label}`, () => {
  const input = lesson(overrides);
  assert.equal(schemaAccepts(lessonSchema, input), false);
  assert.throws(() => validateLesson(input), error => error instanceof Error && error.message.length > 10);
});

test('semantic refinements reject bad FEN, illegal moves, duplicate names and invalid annotation plies', () => {
  for (const [overrides, error] of [
    [{ title: '   ' }, /nonblank/], [{ explanation: '\n\t' }, /nonblank/],
    [{ fen: START.split(' ')[0] }, /six-field/],
    [{ fen: '8/8/8/8/8/8/8/8 w - - 0 1' }, /Invalid FEN/],
    [{ fen: START.replace('KQkq', 'HAha') }, /standard-chess/],
    [{ fen: START.replace(' - 0 1', ' d6 0 1') }, /en passant/],
    [{ variations: [{ name: 'Same', moves: [] }, { name: 'Same', moves: [] }] }, /names must be unique/],
    [{ variations: [{ name: 'Line', moves: ['e2e5'] }] }, /Variation 1, ply 1/],
    [{ fen: '4kr2/8/8/8/8/8/8/4K2R w K - 0 1', variations: [{ name: 'Through check', moves: ['e1g1'] }] }, /illegal/],
    [{ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', variations: [{ name: 'Rook destination', moves: ['e1h1'] }] }, /king destination/],
    [{ fen: '7k/P7/8/8/8/8/8/7K w - - 0 1', variations: [{ name: 'Missing suffix', moves: ['a7a8'] }] }, /promotions require/],
    [{ annotations: { explanation: ' ' } }, /nonblank/],
    [{ variations: [{ name: 'Line', moves: [], annotations: [{ ply: 1 }] }] }, /between 0 and 0/],
    [{ variations: [{ name: 'Line', moves: [], annotations: [{ ply: 0 }, { ply: 0 }] }] }, /duplicate annotation ply/],
  ]) {
    const input = lesson(overrides);
    assert.equal(schemaAccepts(lessonSchema, input), true);
    const before = structuredClone(input);
    assert.throws(() => validateLesson(input), error);
    assert.deepEqual(input, before);
  }
  for (const value of [null, [], new Date(), 'lesson']) assert.throws(() => validateLesson(value), /plain data object/);
  const inherited = Object.assign(Object.create({ hidden: true }), lesson());
  assert.throws(() => validateLesson(inherited), /plain data object/);
});
