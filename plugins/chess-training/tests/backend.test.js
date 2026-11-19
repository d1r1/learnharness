import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { activate } from "../src/backend.js";
import { questionSchema, answerSchema, initialState } from "../src/core.js";
import { lessonSchema, validateLesson } from "../src/lesson-core.js";

const identity = { chatId: "chat", questionId: "stable-host-question", contractVersion: 1 };
const puzzle = () => ({
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  lines: [["e2e4", "e7e5", "g1f3"]],
  hints: [["Occupy the center", "Play e4"], ["Develop a knight"]],
});

const lesson = () => ({
  version: 1, title: "Central development", explanation: "Control the center, then develop.",
  fen: puzzle().fen, orientation: "white",
  annotations: { arrows: [{ from: "e2", to: "e4", color: "green" }] },
  variations: [{ name: "Open game", moves: ["e2e4", "e7e5"], annotations: [
    { ply: 2, explanation: "Both sides occupy the center.", circles: [{ square: "e5", color: "blue" }] },
  ] }],
});

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), "chess-backend-"));
  const controller = new AbortController();
  const handlers = new Map();
  const questions = [];
  const instructions = [];
  const tools = [];
  const removed = [];
  let dispose;
  const ctx = {
    directory,
    dataDirectory: directory,
    signal: controller.signal,
    handle(name, handler) {
      assert.equal(handlers.has(name), false);
      handlers.set(name, handler);
      return () => { removed.push(name); handlers.delete(name); };
    },
    registerQuestionType(definition) {
      questions.push(definition);
      return () => { removed.push("question"); };
    },
    registerTools(contribution) {
      tools.push(contribution);
      return () => { removed.push("tools"); };
    },
    registerInstructions(contribution) {
      instructions.push(contribution);
      return () => { removed.push("instructions"); };
    },
  };
  t.after(async () => { await dispose?.(); await fs.rm(directory, { recursive: true, force: true }); });
  dispose = activate(ctx);
  return { directory, ctx, handlers, questions, instructions, tools, removed, controller, dispose };
}

test("preserves probe and teach native puzzle schema without answer grading or models", async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.handlers.keys()], ["open-puzzle", "act-puzzle"]);
  assert.equal(f.questions.length, 1);
  const definition = f.questions[0];
  assert.equal(definition.id, "puzzle");
  assert.equal(definition.label, "Chess training");
  assert.equal(definition.contractVersion, 1);
  assert.equal(definition.showThinking, true);
  assert.equal(definition.teach.toolName, "chess_training_question");
  assert.equal(typeof definition.teach.description, "string");
  assert.equal(definition.probe.toolName, "chess_training_probe");
  assert.equal(typeof definition.probe.description, "string");
  assert.notEqual(definition.probe.toolName, definition.teach.toolName);
  assert.equal(Object.hasOwn(definition, "validateAnswer"), false);
  assert.equal(Object.hasOwn(definition, "execute"), false);
  assert.deepEqual(definition.questionSchema, questionSchema);
  assert.deepEqual(definition.answerSchema, answerSchema);
  assert.equal(Compile(definition.questionSchema).Check(puzzle()), true);
  const check = Compile(definition.answerSchema);
  // Legal UCI shape but not an accepted authored line: host submission must permit teacher review.
  assert.equal(check.Check({ moves: ["d2d4"], incorrectAttempts: [{ atPly: 0, move: "bad move" }], revealedHints: [] }), true);
  assert.equal(check.Check(initialState()), true);
  assert.equal(check.Check({ moves: ["not-uci"], incorrectAttempts: [], revealedHints: [] }), false);
  assert.equal(check.Check({ ...initialState(), correctness: true }), false);
});

test("teacher-only lesson tool returns a detached immutable artifact without duplicating model content", async t => {
  const f = await fixture(t);
  assert.equal(f.tools.length, 2);
  assert.deepEqual(f.tools[0].agents, ["teacher"]);
  const [tool] = f.tools[0].create(Object.freeze({ chatId: "isolated", agent: "teacher" }));
  assert.equal(tool.name, "chess_training_lesson");
  assert.deepEqual(tool.parameters, lessonSchema);
  assert.equal(Compile(tool.parameters).Check(lesson()), true);
  const authored = lesson();
  const expected = validateLesson(authored);
  const result = await tool.execute("lesson-call", authored, new AbortController().signal);
  assert.deepEqual(result.details, expected);
  assert.notEqual(result.details, authored);
  assert.equal(Object.isFrozen(result.details), true);
  assert.equal(Object.isFrozen(result.details.variations[0].moves), true);
  assert.deepEqual(result.content, [{ type: "text", text: "Chess lesson presented." }]);
  assert.equal(Object.hasOwn(result, "endRun"), false);
  authored.variations[0].moves[0] = "d2d4";
  assert.deepEqual(result.details, expected);
  assert.deepEqual(await fs.readdir(f.directory), [], "lesson execution must not store progress");
  assert.notEqual(f.tools[0].create({ chatId: "other", agent: "teacher" })[0], tool);
});

test("lesson tool refuses invalid artifacts and fences cancellation and disposed captured tools", async t => {
  const f = await fixture(t);
  const [tool] = f.tools[0].create({ chatId: "isolated", agent: "teacher" });
  const signal = new AbortController().signal;
  for (const invalid of [null, { ...lesson(), version: 2 }, { ...lesson(), fen: "invalid" },
    { ...lesson(), variations: [{ name: "Illegal", moves: ["e2e5"] }] },
    { ...lesson(), annotations: { highlights: [{ square: "e4", color: "purple" }] } }]) {
    await assert.rejects(tool.execute("invalid", invalid, signal), error => typeof error.message === "string" && error.message.length > 0);
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tool.execute("cancelled", lesson(), cancelled.signal), /cancelled/);
  f.controller.abort();
  await assert.rejects(tool.execute("disabled", lesson(), signal), /cancelled/);
  await f.dispose();
  await assert.rejects(tool.execute("disposed", lesson(), signal), /cancelled/);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("lesson instructions distinguish public material, local exploration and fresh independent puzzles", async t => {
  const f = await fixture(t);
  const text = f.instructions[0].text;
  for (const expected of [/chess_training_lesson/, /version 1 lesson/, /orientation/, /same starting FEN/,
    /any legal length/, /ply \(0 is the starting position; 1 is after the first move\)/,
    /green, red, blue or yellow/, /never executable code or requests for code execution/,
    /not the learner's local board exploration/, /do not claim to observe/,
    /fresh independent puzzle/, /do not synchronize/, /does not submit an answer/]) assert.match(text, expected);
  assert.doesNotMatch(f.instructions[1].text, /chess_training_lesson/);
});

test("analysis is shared by teacher/prober and instructions distinguish finite evidence from grading", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.tools[1].agents, ["teacher", "prober"]);
  const [tool] = f.tools[1].create({ agent: "prober", chatId: "isolated" });
  assert.equal(tool.name, "chess_training_analyze");
  await assert.rejects(tool.execute("invalid", { fen: "bad" }), /FEN/);
  const text = f.instructions[2].text;
  for (const expression of [/actual chess_training_analyze/, /Partial.*never means a move is wrong/, /Missing MultiPV.*cannot prove uniqueness/, /NOT all engine-checked/, /intentionally demonstrate bad but legal moves/, /ordinary teacher\/prober review remain unchanged/]) assert.match(text, expression);
  for (const instruction of f.instructions.slice(0, 2)) assert.match(instruction.text, /Neither its name nor its count establishes a chess mistake/);
  await f.dispose();
  await assert.rejects(tool.execute("late", { fen: puzzle().fen }), /cancelled/);
});

test("question refinement is synchronous, readable and validates only authored puzzle structure", async t => {
  const f = await fixture(t);
  const validate = payload => f.questions[0].validateQuestion({ chatId: identity.chatId, variant: "teach", contractVersion: 1, input: { question: "Find a move", type: "predict", nodeId: "node", payload } });
  assert.equal(validate(puzzle()), undefined);
  for (const bad of [null, { ...puzzle(), fen: "invalid" }, { ...puzzle(), lines: [["e2e5"]] }, { ...puzzle(), hints: [] }]) {
    const errors = validate(bad);
    assert.equal(Array.isArray(errors), true);
    assert.equal(errors.length > 0, true);
    assert.equal(typeof errors[0], "string");
    assert.equal(errors[0].length > 10, true);
  }
  const payload = puzzle();
  Object.freeze(payload);
  assert.equal(validate(payload), undefined);
});

test("teacher-only instructions cover authoring, hint semantics and ordinary full-answer review", async t => {
  const f = await fixture(t);
  assert.equal(f.instructions.length, 3);
  assert.deepEqual(f.instructions[0].agents, ["teacher"]);
  const text = f.instructions[0].text;
  for (const expected of [/common question.*learner-facing condition/i, /full six-field.*FEN BEFORE the first learner move/, /complete legal standard UCI/, /odd length.*end on a learner move/, /shared per-learner-move/, /progressive hints/, /not a strategic guarantee/, /without code or solutions/, /ordinary final teacher review/, /answer\.moves/, /answer\.incorrectAttempts/, /answer\.revealedHints/]) assert.match(text, expected);
});

test("prober-only instructions require interactive evidence without bypassing diagnosis", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.instructions.map(value => value.agents), [["teacher"], ["prober"], ["teacher", "prober"]]);
  const text = f.instructions[1].text;
  for (const expected of [/chess_training_probe/, /actual interactive chess puzzles/, /not screenshots or text-only/, /do not ask the learner to install or locate/, /without teach-only type or nodeId/, /full six-field.*FEN BEFORE the first learner move/, /complete legal standard UCI/, /odd length.*end on a learner move/, /shared per-learner-move/, /only on explicit '\?' requests/, /host Submit button/, /optional host Your thinking/, /ordinary prober review/, /answer\.moves/, /answer\.incorrectAttempts/, /answer\.revealedHints/, /Do not fabricate an assessment, skip diagnosis or force probe_done/]) assert.match(text, expected);
});

test("public handlers execute controller events and restore plugin-owned state, never host answer", async t => {
  const f = await fixture(t);
  const open = f.handlers.get("open-puzzle");
  const act = f.handlers.get("act-puzzle");
  const opened = await open({ identity, payload: puzzle() });
  const update = event => act({ identity, payload: puzzle(), lease: opened.lease, revision: opened.revision, event });
  const result = await update({ type: "move", uci: "d2d4" });
  assert.equal(result.accepted, false);
  assert.equal(result.revision, 1);
  assert.deepEqual(result.state.moves, []);
  assert.deepEqual(result.state.incorrectAttempts, [{ atPly: 0, move: "d2d4" }]);
  await assert.rejects(update({ type: "hint" }), /revision/);
  assert.throws(() => open({ identity, payload: puzzle(), answer: { ...initialState(), moves: ["e2e4", "e7e5"] } }), /only identity and payload/);
  await assert.rejects(act({ identity, payload: puzzle(), lease: opened.lease, revision: 1, event: { type: "hint" }, state: initialState() }), /only/);
  const remount = await open({ identity, payload: puzzle() });
  assert.deepEqual(remount.state, result.state);
  await assert.rejects(act({ identity, payload: puzzle(), lease: opened.lease, revision: 1, event: { type: "hint" } }), /lease/);
  await f.dispose();
  const removed = [...f.removed];
  assert.equal(f.handlers.size, 0);
  assert.equal(removed.filter(name => name === "instructions").length, 3);
  assert.equal(removed.filter(name => name === "question").length, 1);
  assert.equal(removed.filter(name => name === "tools").length, 2);
  assert.deepEqual(new Set(removed), new Set(["open-puzzle", "act-puzzle", "question", "tools", "instructions"]));
  await f.dispose();
  assert.deepEqual(f.removed, removed);
  await assert.rejects(open({ identity, payload: puzzle() }), /closed/);
  const newHandlers = new Map();
  const disposeAgain = activate({ ...f.ctx, handle(name, handler) { newHandlers.set(name, handler); return () => newHandlers.delete(name); } });
  try {
    const restored = await newHandlers.get("open-puzzle")({ identity, payload: puzzle() });
    assert.deepEqual(restored.state, result.state);
    assert.equal(restored.revision, 1);
    await assert.rejects(newHandlers.get("act-puzzle")({ identity, payload: puzzle(), lease: remount.lease, revision: 1, event: { type: "hint" } }), /lease/);
  } finally { await disposeAgain(); }
});

test("ctx cancellation fences handlers and retains puzzle data on unload", async t => {
  const f = await fixture(t);
  const open = f.handlers.get("open-puzzle");
  const act = f.handlers.get("act-puzzle");
  const opened = await open({ identity, payload: puzzle() });
  const directory = join(f.directory, "puzzles");
  const names = await fs.readdir(directory);
  const bytes = await fs.readFile(join(directory, names[0]), "utf8");
  f.controller.abort();
  await assert.rejects(act({ identity, payload: puzzle(), lease: opened.lease, revision: 0, event: { type: "hint" } }), /aborted/);
  await assert.rejects(open({ identity, payload: puzzle() }), /aborted/);
  await f.dispose();
  assert.equal(await fs.readFile(join(directory, names[0]), "utf8"), bytes);
});

test("disposed lesson tools are fenced even without activation abort", async t => {
  const f = await fixture(t);
  const [tool] = f.tools[0].create({ chatId: "isolated", agent: "teacher" });
  await f.dispose();
  assert.equal(f.controller.signal.aborted, false);
  await assert.rejects(tool.execute("late-call", lesson(), new AbortController().signal), /cancelled/);
});

test("late activation failure unregisters the lesson and puzzle contributions", () => {
  const removed = [];
  assert.throws(() => activate({
    dataDirectory: "unused-no-io", signal: new AbortController().signal,
    handle(name) { return () => removed.push(name); },
    registerQuestionType() { return () => removed.push("question"); },
    registerTools() { return () => removed.push("tools"); },
    registerInstructions() { throw new Error("Instructions refused"); },
  }), /Instructions refused/);
  assert.deepEqual(removed, ["tools", "tools", "question", "act-puzzle", "open-puzzle"]);
});

test("activation failure unregisters already installed handlers", () => {
  const removed = [];
  assert.throws(() => activate({
    dataDirectory: "unused-no-io",
    signal: new AbortController().signal,
    handle(name) { return () => removed.push(name); },
    registerQuestionType() { throw new Error("Registration refused"); },
  }), /Registration refused/);
  assert.deepEqual(removed, ["act-puzzle", "open-puzzle"]);
});
