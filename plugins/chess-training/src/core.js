import { Chess, normalizeMove, castlingSide } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { parseUci, makeUci } from "chessops/util";

const uciPattern = "^[a-h][1-8][a-h][1-8][qrbn]?$";
const uciRegex = new RegExp(uciPattern);
const moveSchema = { type: "string", pattern: uciPattern };
const integerSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

export const questionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fen", "lines", "hints"],
  properties: {
    fen: { type: "string", minLength: 1 },
    lines: { type: "array", minItems: 1, items: { type: "array", minItems: 1, items: moveSchema } },
    hints: { type: "array", minItems: 1, items: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } },
  },
};

export const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["moves", "incorrectAttempts", "revealedHints"],
  properties: {
    moves: { type: "array", items: moveSchema },
    incorrectAttempts: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["atPly", "move"],
        properties: { atPly: integerSchema, move: { type: "string" } },
      },
    },
    revealedHints: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["learnerMove", "count"],
        properties: { learnerMove: integerSchema, count: { ...integerSchema, minimum: 1 } },
      },
    },
  },
};

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function objectWithKeys(value, keys, label) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  requireThat(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${label} must contain only ${keys.join(", ")}.`);
}

export function startPosition(fen) {
  requireThat(typeof fen === "string", "FEN must be a string.");
  const fields = fen.split(/\s+/);
  requireThat(fields.length === 6 && /^[prnbqkPRNBQK1-8/]+$/.test(fields[0]) && /^(w|b)$/.test(fields[1]) && /^(?:-|K?Q?k?q?)$/.test(fields[2]) && fields[2] !== "" && /^(?:-|[a-h][36])$/.test(fields[3]) && /^\d+$/.test(fields[4]) && /^[1-9]\d*$/.test(fields[5]), "FEN must be a full six-field standard-chess FEN.");
  let setup;
  let pos;
  try {
    setup = parseFen(fen).unwrap();
    pos = Chess.fromSetup(setup).unwrap();
  } catch (error) {
    throw new Error(`Invalid FEN: ${error.message}`);
  }
  // Chessops also parses Chess960 rights. This format deliberately permits only standard chess.
  for (const [right, color, king, rook] of [["K", "white", 4, 7], ["Q", "white", 4, 0], ["k", "black", 60, 63], ["q", "black", 60, 56]]) {
    if (fields[2].includes(right)) {
      requireThat(pos.board.kingOf(color) === king && pos.board.rook.has(rook) && pos.board[color].has(rook) && setup.castlingRights.has(rook), "FEN castling rights must describe standard king and rook squares.");
    }
  }
  requireThat(fields[3] === "-" || pos.epSquare === setup.epSquare, "FEN has an incoherent en passant square.");
  return pos;
}

// Persist normal UCI (king destination for castling), not chessops' king-to-rook encoding.
export function legalMove(pos, uci) {
  if (typeof uci !== "string" || !uciRegex.test(uci)) return undefined;
  const move = parseUci(uci);
  if (!move || !pos.isLegal(move)) return undefined;
  const side = castlingSide(pos, move);
  if (side) {
    const kingTo = (pos.turn === "white" ? 0 : 56) + (side === "h" ? 6 : 2);
    if (makeUci({ from: move.from, to: kingTo }) !== uci) return undefined;
  }
  return normalizeMove(pos, move);
}

export function validatePuzzle(payload) {
  objectWithKeys(payload, ["fen", "lines", "hints"], "Puzzle");
  const start = startPosition(payload.fen);
  requireThat(Array.isArray(payload.lines) && payload.lines.length > 0, "Puzzle lines must be a nonempty array.");
  let maxLearnerMoves = 0;
  payload.lines.forEach((line, index) => {
    requireThat(Array.isArray(line) && line.length > 0 && line.length % 2 === 1, `Line ${index + 1} must be nonempty and end on a learner move (odd ply count).`);
    const pos = start.clone();
    line.forEach((uci, ply) => {
      const move = legalMove(pos, uci);
      requireThat(move, `Line ${index + 1}, ply ${ply + 1}: illegal standard UCI move ${String(uci)}.`);
      pos.play(move);
    });
    maxLearnerMoves = Math.max(maxLearnerMoves, (line.length + 1) / 2);
  });
  requireThat(Array.isArray(payload.hints) && payload.hints.length === maxLearnerMoves, `Hints must contain exactly ${maxLearnerMoves} learner-move arrays.`);
  payload.hints.forEach((hints, index) => {
    requireThat(Array.isArray(hints) && hints.length > 0 && hints.every(hint => typeof hint === "string" && hint.trim().length > 0), `Hints for learner move ${index + 1} must be a nonempty progressive array of nonblank text.`);
  });
}

export function initialState() {
  return { moves: [], incorrectAttempts: [], revealedHints: [] };
}

const prefixOf = (prefix, line) => prefix.length <= line.length && prefix.every((move, index) => move === line[index]);
const complete = (payload, moves) => payload.lines.some(line => line.length === moves.length && prefixOf(moves, line));

function transition(payload, moves, pos, uci) {
  const move = legalMove(pos, uci);
  if (!move) return { accepted: false, feedback: "Illegal move. Try again." };
  const next = [...moves, uci];
  const line = payload.lines.find(candidate => prefixOf(next, candidate));
  if (!line) return { accepted: false, feedback: "That legal move is not included in the authored puzzle lines. Its chess quality has not been established. Try another move." };
  pos.play(move);
  if (!complete(payload, next)) {
    const reply = line[next.length];
    pos.play(legalMove(pos, reply));
    next.push(reply);
  }
  return { accepted: true, moves: next, feedback: complete(payload, next) ? "Puzzle complete." : "Matches an authored line. Your turn." };
}

/** Structural/coherence validation only: incomplete states and unsuccessful retries are valid. */
export function validateState(payload, state) {
  validatePuzzle(payload);
  objectWithKeys(state, ["moves", "incorrectAttempts", "revealedHints"], "Answer state");
  requireThat(Array.isArray(state.moves) && state.moves.every(move => typeof move === "string" && uciRegex.test(move)), "State moves must be standard UCI strings.");
  requireThat(Array.isArray(state.incorrectAttempts) && Array.isArray(state.revealedHints), "State attempt and hint records must be arrays.");
  const pos = startPosition(payload.fen);
  let moves = [];
  const positions = new Map();
  while (true) {
    if (!complete(payload, moves)) positions.set(moves.length, pos.clone());
    if (moves.length >= state.moves.length) break;
    requireThat(!complete(payload, moves), "State contains moves after puzzle completion.");
    const result = transition(payload, moves, pos, state.moves[moves.length]);
    requireThat(result.accepted && prefixOf(result.moves, state.moves), "State moves do not match deterministic puzzle transitions and automatic replies.");
    moves = result.moves;
  }
  let previousPly = -1;
  for (const attempt of state.incorrectAttempts) {
    objectWithKeys(attempt, ["atPly", "move"], "Recorded retry");
    requireThat(Number.isSafeInteger(attempt.atPly) && attempt.atPly >= previousPly && positions.has(attempt.atPly) && typeof attempt.move === "string", "Recorded retry must reference a reached learner turn in chronological order.");
    requireThat(!transition(payload, state.moves.slice(0, attempt.atPly), positions.get(attempt.atPly).clone(), attempt.move).accepted, "Recorded retry contains an accepted puzzle move.");
    previousPly = attempt.atPly;
  }
  let previousLearnerMove = -1;
  for (const hint of state.revealedHints) {
    objectWithKeys(hint, ["learnerMove", "count"], "Revealed hint");
    requireThat(Number.isSafeInteger(hint.learnerMove) && hint.learnerMove > previousLearnerMove && positions.has(hint.learnerMove * 2), "Revealed hints must uniquely reference reached learner turns in order.");
    requireThat(Number.isSafeInteger(hint.count) && hint.count >= 1 && hint.count <= payload.hints[hint.learnerMove].length, "Revealed hint count exceeds the authored progressive hints.");
    previousLearnerMove = hint.learnerMove;
  }
}

export function position(payload, state) {
  validateState(payload, state);
  const pos = startPosition(payload.fen);
  for (const uci of state.moves) pos.play(legalMove(pos, uci));
  return pos;
}

export function isComplete(payload, state) {
  validateState(payload, state);
  return complete(payload, state.moves);
}

export function attemptMove(payload, state, uci) {
  const pos = position(payload, state);
  requireThat(typeof uci === "string", "Attempted move must be a string.");
  if (complete(payload, state.moves)) return { state, accepted: false, feedback: "Puzzle already complete." };
  const result = transition(payload, state.moves, pos, uci);
  if (!result.accepted) {
    return { state: { ...state, incorrectAttempts: [...state.incorrectAttempts, { atPly: state.moves.length, move: uci }] }, accepted: false, feedback: result.feedback };
  }
  return { state: { ...state, moves: result.moves }, accepted: true, feedback: result.feedback };
}

/** learnerMove and hintIndex are zero-based indices into payload.hints. */
export function revealHint(payload, state) {
  validateState(payload, state);
  if (complete(payload, state.moves)) return state;
  const learnerMove = state.moves.length / 2;
  const current = state.revealedHints.find(hint => hint.learnerMove === learnerMove);
  const count = current?.count ?? 0;
  if (count === payload.hints[learnerMove].length) return state;
  return {
    ...state,
    revealedHints: current
      ? state.revealedHints.map(hint => hint.learnerMove === learnerMove ? { learnerMove, count: count + 1 } : hint)
      : [...state.revealedHints, { learnerMove, count: 1 }],
  };
}

export function usedHints(payload, state) {
  validateState(payload, state);
  return state.revealedHints.flatMap(({ learnerMove, count }) => payload.hints[learnerMove].slice(0, count).map((text, hintIndex) => ({ learnerMove, hintIndex, text })));
}
