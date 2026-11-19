import { makeFen } from 'chessops/fen';
import { startPosition, legalMove } from './core.js';

const text = { type: 'string', minLength: 1 };
const square = { type: 'string', pattern: '^[a-h][1-8]$' };
const color = { type: 'string', enum: ['green', 'red', 'blue', 'yellow'] };
const annotationProperties = {
  explanation: text,
  arrows: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'to', 'color'], properties: { from: square, to: square, color } } },
  circles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['square', 'color'], properties: { square, color } } },
  highlights: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['square', 'color'], properties: { square, color } } },
};
export const lessonSchema = {
  type: 'object', additionalProperties: false,
  required: ['version', 'title', 'explanation', 'fen', 'orientation', 'variations'],
  properties: {
    version: { type: 'integer', const: 1 }, title: text, explanation: text, fen: text,
    orientation: { type: 'string', enum: ['white', 'black'] },
    annotations: { type: 'object', additionalProperties: false, properties: annotationProperties },
    variations: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'moves'], properties: {
        name: text, moves: { type: 'array', items: { type: 'string', pattern: '^[a-h][1-8][a-h][1-8][qrbn]?$' } },
        annotations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ply'], properties: { ply: { type: 'integer', minimum: 0 }, ...annotationProperties } } },
      },
    } },
  },
};
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function object(value, required, optional, label) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label} must be a plain data object.`);
  requireThat(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), `${label} requires ${required.join(', ') || 'annotation fields'}; allowed fields: ${[...required, ...optional].join(', ')}.`);
}
function nonblank(value, label) { requireThat(typeof value === 'string' && value.trim().length > 0, `${label} must be nonblank text.`); }
function annotations(value, label, withPly = false) {
  object(value, withPly ? ['ply'] : [], Object.keys(annotationProperties), label);
  if (Object.hasOwn(value, 'explanation')) nonblank(value.explanation, `${label}.explanation`);
  for (const kind of ['arrows', 'circles', 'highlights']) {
    if (!Object.hasOwn(value, kind)) continue;
    requireThat(Array.isArray(value[kind]), `${label}.${kind} must be an array.`);
    value[kind].forEach((mark, index) => {
      const fields = kind === 'arrows' ? ['from', 'to', 'color'] : ['square', 'color'];
      object(mark, fields, [], `${label}.${kind}[${index}]`);
      requireThat(['green', 'red', 'blue', 'yellow'].includes(mark.color), `${label}.${kind}[${index}].color must be green, red, blue or yellow.`);
      for (const key of fields.filter(f => f !== 'color')) requireThat(typeof mark[key] === 'string' && /^[a-h][1-8]$/.test(mark[key]), `${label}.${kind}[${index}].${key} must be a board square a1–h8.`);
    });
  }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Strict, side-effect-free validation. Copies preserve all public text verbatim. */
export function validateLesson(input) {
  object(input, ['version', 'title', 'explanation', 'fen', 'orientation', 'variations'], ['annotations'], 'Lesson');
  requireThat(input.version === 1, 'Lesson version must be 1.');
  nonblank(input.title, 'Lesson title'); nonblank(input.explanation, 'Lesson explanation');
  requireThat(['white', 'black'].includes(input.orientation), 'Lesson orientation must be white or black.');
  const start = startPosition(input.fen);
  if (Object.hasOwn(input, 'annotations')) annotations(input.annotations, 'Root annotations');
  requireThat(Array.isArray(input.variations), 'Lesson variations must be an array.');
  const names = new Set();
  input.variations.forEach((variation, index) => {
    const label = `Variation ${index + 1}`;
    object(variation, ['name', 'moves'], ['annotations'], label);
    nonblank(variation.name, `${label} name`);
    requireThat(!names.has(variation.name), `${label}: variation names must be unique.`); names.add(variation.name);
    requireThat(Array.isArray(variation.moves), `${label} moves must be an array.`);
    const pos = start.clone();
    variation.moves.forEach((uci, ply) => {
      const move = legalMove(pos, uci);
      requireThat(move, `${label}, ply ${ply + 1}: illegal standard UCI move ${String(uci)}; promotions require q/r/b/n and castling uses the king destination.`);
      pos.play(move);
    });
    if (Object.hasOwn(variation, 'annotations')) {
      requireThat(Array.isArray(variation.annotations), `${label} annotations must be an array.`);
      const plies = new Set();
      variation.annotations.forEach(a => {
        annotations(a, `${label} annotations`, true);
        requireThat(Number.isSafeInteger(a.ply) && a.ply >= 0 && a.ply <= variation.moves.length, `${label} annotation ply must be between 0 and ${variation.moves.length}.`);
        requireThat(!plies.has(a.ply), `${label} has duplicate annotation ply ${a.ply}.`); plies.add(a.ply);
      });
    }
  });
  return freeze(structuredClone(input));
}
const emptyAnnotations = () => ({ arrows: [], circles: [], highlights: [] });
const publicAnnotations = a => ({ ...emptyAnnotations(), ...(a ? { ...(a.explanation !== undefined ? { explanation: a.explanation } : {}), arrows: a.arrows ?? [], circles: a.circles ?? [], highlights: a.highlights ?? [] } : {}) });

/** No persistence, callbacks, transport or module-global mutable state. */
export function createLessonController(input) {
  const lesson = validateLesson(input);
  let moves = [], variation = null;
  function position() {
    const pos = startPosition(lesson.fen);
    for (const uci of moves) pos.play(legalMove(pos, uci));
    return pos;
  }
  function snapshot() {
    const pos = position();
    const authored = variation === null ? undefined : lesson.variations[variation].annotations?.find(a => a.ply === moves.length);
    const marks = authored ?? (moves.length === 0 ? lesson.annotations : undefined);
    return freeze(structuredClone({ fen: moves.length ? makeFen(pos.toSetup()) : lesson.fen, turn: pos.turn, check: pos.isCheck(), moves, variation, ply: moves.length, annotations: publicAnnotations(marks) }));
  }
  return {
    snapshot,
    move(uci) {
      requireThat(legalMove(position(), uci), 'Illegal move. Use legal standard UCI, including q/r/b/n for promotion.');
      moves = [...moves, uci]; variation = null;
      return snapshot();
    },
    undo() { moves = moves.slice(0, -1); return snapshot(); },
    reset() { moves = []; variation = null; return snapshot(); },
    selectVariation(index, ply = 0) {
      requireThat(Number.isSafeInteger(index) && index >= 0 && index < lesson.variations.length, 'Unknown lesson variation.');
      requireThat(Number.isSafeInteger(ply) && ply >= 0 && ply <= lesson.variations[index].moves.length, 'Variation ply is out of range.');
      variation = index; moves = lesson.variations[index].moves.slice(0, ply); return snapshot();
    },
    step(ply) {
      requireThat(variation !== null, 'Choose an authored variation before stepping.');
      return this.selectVariation(variation, ply);
    },
  };
}
