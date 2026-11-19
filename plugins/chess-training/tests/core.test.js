import test from "node:test";
import assert from "node:assert/strict";
import { makeFen } from "chessops/fen";
import { parseSquare } from "chessops/util";
import {
  questionSchema, answerSchema, validatePuzzle, initialState, validateState,
  position, isComplete, attemptMove, revealHint, usedHints,
} from "../src/core.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const puzzle = (lines = [["e2e4", "e7e5", "g1f3"]], fen = START) => ({
  fen, lines,
  hints: Array.from({ length: Math.max(...lines.map(line => (line.length + 1) / 2)) }, (_, i) => [`Consider move ${i + 1}.`, `More detail ${i + 1}.`, `Explicit move ${i + 1}.`]),
});
const play = (payload, state, move) => {
  const result = attemptMove(payload, state, move);
  assert.equal(result.accepted, true, result.feedback);
  validateState(payload, result.state);
  return result.state;
};
const piece = (pos, square) => pos.board.get(parseSquare(square));

test("schemas are persistable JSON and keep common condition outside payload", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(questionSchema)), questionSchema);
  assert.deepEqual(JSON.parse(JSON.stringify(answerSchema)), answerSchema);
  assert.deepEqual(questionSchema.required, ["fen", "lines", "hints"]);
  assert.deepEqual(answerSchema.required, ["moves", "incorrectAttempts", "revealedHints"]);
  assert.equal(questionSchema.additionalProperties, false);
});

test("initial state is fresh and an incomplete state is valid without grading", () => {
  const state = initialState();
  assert.deepEqual(state, { moves: [], incorrectAttempts: [], revealedHints: [] });
  assert.notEqual(state.moves, initialState().moves);
  assert.doesNotThrow(() => validateState(puzzle(), state));
  assert.equal(isComplete(puzzle(), state), false);
  assert.equal(makeFen(position(puzzle(), state).toSetup()), START);
});

test("synthetic multi-move line automatically replies and completes only on the last learner move", () => {
  const payload = puzzle([["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]]);
  let state = initialState();
  state = play(payload, state, "e2e4");
  assert.deepEqual(state.moves, ["e2e4", "e7e5"]);
  assert.equal(position(payload, state).turn, "white");
  assert.equal(isComplete(payload, state), false);
  state = play(payload, state, "g1f3");
  assert.deepEqual(state.moves, ["e2e4", "e7e5", "g1f3", "b8c6"]);
  state = play(payload, state, "f1b5");
  assert.equal(isComplete(payload, state), true);
  assert.equal(piece(position(payload, state), "b5").role, "bishop");
  const refused = attemptMove(payload, state, "a7a6");
  assert.equal(refused.accepted, false);
  assert.equal(refused.state, state);
  assert.equal(revealHint(payload, state), state);
});

test("illegal and legal off-line attempts record retries without moving the board", () => {
  const payload = puzzle();
  const state = initialState();
  Object.freeze(state.moves);
  Object.freeze(state.incorrectAttempts);
  Object.freeze(state.revealedHints);
  Object.freeze(state);
  let result = attemptMove(payload, state, "e2e5");
  assert.equal(result.accepted, false);
  assert.match(result.feedback, /Illegal/);
  result = attemptMove(payload, result.state, "d2d4");
  assert.equal(result.accepted, false);
  assert.equal(result.feedback, "That legal move is not included in the authored puzzle lines. Its chess quality has not been established. Try another move.");
  result = attemptMove(payload, result.state, "not-uci");
  assert.equal(result.accepted, false);
  assert.deepEqual(result.state.moves, []);
  assert.deepEqual(result.state.incorrectAttempts, [
    { atPly: 0, move: "e2e5" }, { atPly: 0, move: "d2d4" }, { atPly: 0, move: "not-uci" },
  ]);
  assert.equal(makeFen(position(payload, result.state).toSetup()), START);
  let next = play(payload, result.state, "e2e4");
  result = attemptMove(payload, next, "f1c4");
  assert.deepEqual(result.state.moves, ["e2e4", "e7e5"]);
  assert.deepEqual(result.state.incorrectAttempts.at(-1), { atPly: 2, move: "f1c4" });
  next = play(payload, result.state, "g1f3");
  assert.equal(isComplete(payload, next), true);
  assert.equal(next.incorrectAttempts.length, 4);
  assert.deepEqual(state, initialState());
});

test("alternatives accept learner choices and select the first compatible opponent reply", () => {
  const payload = puzzle([
    ["e2e4", "e7e5", "g1f3"],
    ["e2e4", "c7c5", "g1f3"],
    ["d2d4", "d7d5", "c2c4"],
    ["e2e4", "e7e5", "f1c4"],
  ]);
  const e4 = play(payload, initialState(), "e2e4");
  assert.deepEqual(e4.moves, ["e2e4", "e7e5"]);
  assert.equal(attemptMove(payload, initialState(), "e2e4").feedback, "Matches an authored line. Your turn.");
  assert.equal(isComplete(payload, play(payload, e4, "f1c4")), true);
  const d4 = play(payload, initialState(), "d2d4");
  assert.deepEqual(d4.moves, ["d2d4", "d7d5"]);
  assert.equal(isComplete(payload, play(payload, d4, "c2c4")), true);
  const reordered = { ...payload, lines: [payload.lines[1], payload.lines[0]] };
  assert.deepEqual(play(reordered, initialState(), "e2e4").moves, ["e2e4", "c7c5"]);
});

test("completion on any accepted line does not introduce a full-line-prefix restriction", () => {
  const payload = puzzle([["e2e4", "e7e5", "g1f3"], ["e2e4"]]);
  assert.doesNotThrow(() => validatePuzzle(payload));
  const state = play(payload, initialState(), "e2e4");
  assert.deepEqual(state.moves, ["e2e4"]);
  assert.equal(isComplete(payload, state), true);
});

test("black-to-move FEN starts with the learner, not an automatic white move", () => {
  const payload = puzzle([["e7e5", "g1f3", "b8c6"]], "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
  assert.equal(position(payload, initialState()).turn, "black");
  const state = play(payload, initialState(), "e7e5");
  assert.deepEqual(state.moves, ["e7e5", "g1f3"]);
  assert.equal(position(payload, state).turn, "black");
  assert.equal(isComplete(payload, play(payload, state, "b8c6")), true);
});

for (const promotion of ["q", "r", "b", "n"]) {
  test(`promotion ${promotion} is explicit and preserved`, () => {
    const payload = puzzle([[`a7a8${promotion}`]], "7k/P7/8/8/8/8/8/7K w - - 0 1");
    assert.equal(attemptMove(payload, initialState(), "a7a8").accepted, false);
    const state = play(payload, initialState(), `a7a8${promotion}`);
    assert.equal(isComplete(payload, state), true);
    assert.equal(piece(position(payload, state), "a8").role, { q: "queen", r: "rook", b: "bishop", n: "knight" }[promotion]);
  });
}

test("legal off-line promotion is a retry, not silently upgraded to the authored piece", () => {
  const payload = puzzle([["a7a8n"]], "7k/P7/8/8/8/8/8/7K w - - 0 1");
  const result = attemptMove(payload, initialState(), "a7a8q");
  assert.equal(result.accepted, false);
  assert.equal(result.feedback, "That legal move is not included in the authored puzzle lines. Its chess quality has not been established. Try another move.");
  assert.equal(piece(position(payload, result.state), "a7").role, "pawn");
});

for (const [move, king, rook] of [["e1g1", "g1", "f1"], ["e1c1", "c1", "d1"]]) {
  test(`standard castling ${move} normalizes deliberately without changing persisted UCI`, () => {
    const payload = puzzle([[move]], "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const state = play(payload, initialState(), move);
    const pos = position(payload, state);
    assert.deepEqual(state.moves, [move]);
    assert.equal(piece(pos, king).role, "king");
    assert.equal(piece(pos, rook).role, "rook");
    assert.equal(attemptMove(payload, initialState(), "e1h1").accepted, false);
  });
}

test("castling through check is illegal", () => {
  const payload = puzzle([["e1d1"]], "4kr2/8/8/8/8/8/8/4K2R w K - 0 1");
  assert.equal(attemptMove(payload, initialState(), "e1g1").accepted, false);
  assert.throws(() => validatePuzzle({ ...payload, lines: [["e1g1"]] }), /illegal/);
});

test("a pinned piece cannot expose its king even if the move has a valid UCI shape", () => {
  const payload = puzzle([["e2e8"]], "4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1");
  const result = attemptMove(payload, initialState(), "e2d2");
  assert.equal(result.accepted, false);
  assert.match(result.feedback, /Illegal/);
  assert.deepEqual(result.state.moves, []);
});

test("automatic black castling uses normal UCI", () => {
  const payload = puzzle([["a2a3", "e8g8", "a3a4"]], "r3k2r/8/8/8/8/8/P7/4K3 w kq - 0 1");
  const state = play(payload, initialState(), "a2a3");
  assert.deepEqual(state.moves, ["a2a3", "e8g8"]);
  assert.equal(piece(position(payload, state), "g8").role, "king");
  assert.equal(piece(position(payload, state), "f8").role, "rook");
});

test("en passant uses the initial FEN target and removes the captured pawn", () => {
  const payload = puzzle([["e5d6"]], "7k/8/8/3pP3/8/8/8/7K w - d6 0 2");
  const state = play(payload, initialState(), "e5d6");
  const pos = position(payload, state);
  assert.equal(piece(pos, "d5"), undefined);
  assert.deepEqual(piece(pos, "d6"), { role: "pawn", color: "white", promoted: false });
});

test("hints require explicit progressive reveals, retain exact text and prior turn usage", () => {
  const payload = puzzle();
  payload.hints = [[" First hint. ", "Second hint.", "Play e4."], ["Develop a piece.", "Play Nf3."]];
  let state = initialState();
  assert.deepEqual(usedHints(payload, state), []);
  state = revealHint(payload, state);
  assert.deepEqual(state.revealedHints, [{ learnerMove: 0, count: 1 }]);
  assert.deepEqual(usedHints(payload, state), [{ learnerMove: 0, hintIndex: 0, text: " First hint. " }]);
  const beforeRetry = state;
  state = attemptMove(payload, state, "d2d4").state;
  assert.deepEqual(state.revealedHints, beforeRetry.revealedHints);
  state = revealHint(payload, state);
  state = revealHint(payload, state);
  assert.equal(revealHint(payload, state), state);
  state = play(payload, state, "e2e4");
  assert.equal(usedHints(payload, state).length, 3);
  state = revealHint(payload, state);
  assert.deepEqual(state.revealedHints, [{ learnerMove: 0, count: 3 }, { learnerMove: 1, count: 1 }]);
  state = play(payload, state, "g1f3");
  assert.equal(usedHints(payload, state).length, 4);
  assert.equal(revealHint(payload, state), state);
});

test("invalid authored FEN, lines and hint shapes fail with readable errors", () => {
  const invalid = [
    { ...puzzle(), fen: START.split(" ")[0] },
    { ...puzzle(), fen: START.replace(" 0 1", " 0 0") },
    { ...puzzle(), fen: "8/8/8/8/8/8/8/8 w - - 0 1" },
    { ...puzzle(), fen: START.replace("KQkq", "HAha") },
    { ...puzzle(), fen: "4k3/8/8/8/8/8/8/3K3R w K - 0 1" },
    { ...puzzle(), fen: START.replace(" - 0 1", " d6 0 1") },
    { ...puzzle(), lines: [] },
    { ...puzzle(), lines: [[]] },
    { ...puzzle(), lines: [["e2e4", "e7e5"]] },
    { ...puzzle(), lines: [["e2e5"]], hints: [["Hint"]] },
    { ...puzzle(), lines: [["e2e4", "e7e4", "g1f3"]] },
    { ...puzzle(), lines: [["e4"]], hints: [["Hint"]] },
    { ...puzzle(), hints: [["Only one turn"]] },
    { ...puzzle(), hints: [[], ["Hint"]] },
    { ...puzzle(), hints: [["   "], ["Hint"]] },
    { ...puzzle(), condition: "Host already owns this." },
  ];
  for (const payload of invalid) assert.throws(() => validatePuzzle(payload), error => error instanceof Error && error.message.length > 10);
});

test("state validation rejects forged paths, missing/wrong replies and post-completion moves", () => {
  const payload = puzzle();
  for (const moves of [["e2e4"], ["e2e4", "c7c5"], ["d2d4", "d7d5"], ["e2e4", "e7e5", "g1f3", "b8c6"], ["e4"]]) {
    assert.throws(() => validateState(payload, { ...initialState(), moves }));
  }
  const terminalPrefix = puzzle([["e2e4"], ["e2e4", "e7e5", "g1f3"]]);
  assert.throws(() => validateState(terminalPrefix, { ...initialState(), moves: ["e2e4", "e7e5", "g1f3"] }), /completion/);
});

test("state validation checks attempt chronology, reached turns and actual rejection, not final correctness", () => {
  const payload = puzzle();
  const state = play(payload, initialState(), "e2e4");
  for (const incorrectAttempts of [
    [{ atPly: 0, move: "e2e4" }],
    [{ atPly: 1, move: "e7e6" }],
    [{ atPly: 4, move: "a2a3" }],
    [{ atPly: -1, move: "e2e5" }],
    [{ atPly: 2, move: "a2a3" }, { atPly: 0, move: "e2e5" }],
    [{ atPly: 0, move: 42 }],
  ]) assert.throws(() => validateState(payload, { ...state, incorrectAttempts }));
  assert.doesNotThrow(() => validateState(payload, { ...state, incorrectAttempts: [{ atPly: 0, move: "bad input" }, { atPly: 2, move: "a2a3" }] }));
});

test("state validation checks hint bounds, uniqueness and reachable learner turns", () => {
  const payload = puzzle();
  const state = play(payload, initialState(), "e2e4");
  for (const revealedHints of [
    [{ learnerMove: 2, count: 1 }], [{ learnerMove: 0, count: 0 }],
    [{ learnerMove: 0, count: 4 }], [{ learnerMove: 0, count: 1.5 }],
    [{ learnerMove: -1, count: 1 }], [{ learnerMove: 0, count: 1 }, { learnerMove: 0, count: 2 }],
    [{ learnerMove: 1, count: 1 }, { learnerMove: 0, count: 1 }],
  ]) assert.throws(() => validateState(payload, { ...state, revealedHints }));
  assert.throws(() => validateState(payload, { ...initialState(), revealedHints: [{ learnerMove: 1, count: 1 }] }));
  const terminal = play(payload, state, "g1f3");
  assert.throws(() => validateState(payload, { ...terminal, incorrectAttempts: [{ atPly: 3, move: "a7a6" }] }));
});
