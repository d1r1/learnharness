import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAnalyzer, parseInfo, validateAnalysis, analysisSchema } from "../src/analyze.js";

const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const info = "info depth 9 seldepth 12 multipv 1 score cp 32 nodes 1234 time 120 pv e2e4 e7e5";
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class FakeWorker extends EventEmitter {
  commands = [];
  terminated = false;
  terminationCalls = 0;
  constructor(behavior = () => false, terminate) { super(); this.behavior = behavior; this.finishTermination = terminate; }
  postMessage(command) {
    this.commands.push(command);
    queueMicrotask(() => {
      if (this.behavior(command, this)) return;
      if (command === "uci") { this.emit("message", "id name Stockfish 19 Lite"); this.emit("message", "uciok"); }
      if (command === "isready") this.emit("message", "readyok");
      if (command.startsWith("go ")) {
        const candidate = command.split("searchmoves ")[1] ?? "e2e4";
        this.emit("message", info.replace("pv e2e4", `pv ${candidate}`));
        this.emit("message", `bestmove ${candidate}`);
      }
    });
  }
  async terminate() {
    this.terminationCalls++;
    await this.finishTermination?.();
    this.terminated = true;
    this.emit("exit", 1);
    return 1;
  }
}

function fixture(t, behavior, terminate) {
  const activation = new AbortController();
  const workers = [];
  const paths = [];
  const analyzer = createAnalyzer("/disposable-installed/chess-training", activation.signal, file => {
    paths.push(file);
    const worker = new FakeWorker(behavior, terminate);
    workers.push(worker);
    return worker;
  });
  t.after(() => analyzer.dispose());
  return { analyzer, activation, workers, paths };
}

function clock(t) {
  let now = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  return async ms => { now += ms; t.mock.timers.tick(ms); await flush(); };
}

test("UCI scores preserve side-to-move perspective, cp versus mate, bounds and PV", () => {
  for (const perspective of ["white", "black"]) {
    for (const [unit, value, bound] of [["cp", -52, "upperbound"], ["mate", 3, "lowerbound"], ["mate", -2, "exact"], ["mate", 0, "exact"]]) {
      const parsed = parseInfo(`info depth 12 score ${unit} ${value} ${bound === "exact" ? "" : bound} nodes 95 time 8 pv a7a8n`, perspective);
      assert.deepEqual(parsed, { score: { unit, value, bound, perspective }, depth: 12, nodes: 95, timeMs: 8, pv: ["a7a8n"] });
    }
  }
  assert.deepEqual(parseInfo("info depth 0 score mate 0", "black").pv, []);
  for (const line of ["info string score cp 5", "info depth 3 currmove e2e4", "info score cp NaN", "info score cp 1 pv nope", "info multipv 2 score cp 2", "info score cp 9007199254740992"]) assert.equal(parseInfo(line, "white"), undefined);
  assert.deepEqual(parseInfo(info, "white").pv, ["e2e4", "e7e5"]);
});

test("input validation rejects illegal, duplicated, oversized or injected requests before worker creation", async t => {
  const f = fixture(t);
  for (const input of [null, {}, { fen: "bad" }, { fen, unknown: true }, { fen: fen + "\nquit" },
    { fen, candidates: [] }, { fen, candidates: ["e2e4", "e2e4"] }, { fen, candidates: ["e2e5"] },
    { fen, candidates: ["e1h1"] }, { fen, candidates: "e2e4" }, { fen, candidates: Array(9).fill("e2e4") }]) {
    await assert.rejects(f.analyzer.analyze(input), /FEN|requires|Candidates/);
  }
  assert.equal(f.workers.length, 0);
  assert.deepEqual(validateAnalysis({ fen, candidates: ["d2d4"] }), { fen, candidates: ["d2d4"], perspective: "white" });
  assert.equal(analysisSchema.additionalProperties, false);
});

test("sequential baseline and explicit searchmoves share root perspective and await termination", async t => {
  let release;
  const f = fixture(t, undefined, () => new Promise(resolve => { release = resolve; }));
  let settled = false;
  const pending = f.analyzer.analyze({ fen, candidates: ["d2d4", "g1f3"] }).then(result => { settled = true; return result; });
  await flush();
  assert.equal(settled, false);
  assert.equal(f.workers.length, 1);
  assert.deepEqual(f.paths, ["/disposable-installed/chess-training/engine-worker.cjs"]);
  const worker = f.workers[0];
  assert.deepEqual(worker.commands.filter(cmd => cmd.startsWith("go ")), ["go movetime 175", "go movetime 175 searchmoves d2d4", "go movetime 175 searchmoves g1f3"]);
  assert.ok(worker.commands.includes("setoption name Threads value 1"));
  assert.ok(worker.commands.includes("setoption name Hash value 16"));
  assert.equal(worker.terminationCalls, 1);
  assert.equal(worker.terminated, false);
  release();
  const result = await pending;
  assert.equal(worker.terminated, true);
  assert.equal(result.completed, true);
  assert.equal(result.partial, false);
  assert.deepEqual(result.searches.map(search => search.candidate), [null, "d2d4", "g1f3"]);
  assert.equal(result.searches[1].evidence.score.perspective, "white");
  assert.equal(Object.hasOwn(result, "verified"), false);
  assert.match(result.limitations, /no repetition history/);
  assert.equal(worker.listenerCount("message"), 0);
});

test("no score progress is partial, not an invented grade", async t => {
  const f = fixture(t, (command, worker) => {
    if (!command.startsWith("go ")) return false;
    worker.emit("message", "bestmove e2e4");
    return true;
  });
  const result = await f.analyzer.analyze({ fen });
  assert.equal(result.partial, true);
  assert.equal(result.reason, "no-score-progress");
  assert.equal(result.searches[0].evidence, null);
  assert.equal(f.workers[0].terminated, true);
});

test("parent search timer stops and terminates hung engine, retaining partial evidence", async t => {
  const advance = clock(t);
  const f = fixture(t, (command, worker) => {
    if (!command.startsWith("go ")) return false;
    worker.emit("message", info);
    return true;
  });
  const pending = f.analyzer.analyze({ fen, candidates: ["d2d4"] });
  await flush();
  await advance(180);
  assert.equal(f.workers[0].commands.at(-1), "stop");
  await advance(20);
  const result = await pending;
  assert.equal(result.reason, "search-budget");
  assert.equal(result.searches[0].evidence.depth, 9);
  assert.equal(result.searches[0].completed, false);
  assert.deepEqual(result.unsearchedCandidates, ["d2d4"]);
  assert.equal(f.workers[0].terminated, true);
});

test("initialization deadline is parent-owned, busy refuses concurrent work and late exits are fenced", async t => {
  const advance = clock(t);
  const f = fixture(t, command => command === "uci");
  const pending = f.analyzer.analyze({ fen });
  await assert.rejects(f.analyzer.analyze({ fen }), /busy/);
  await advance(2800);
  const result = await pending;
  assert.equal(result.reason, "request-budget");
  assert.deepEqual(result.searches, []);
  const snapshot = structuredClone(result);
  f.workers[0].emit("message", "bestmove e2e4");
  f.workers[0].emit("exit", 0);
  assert.deepEqual(result, snapshot);
  assert.equal(f.workers[0].terminated, true);
});

test("remaining budget shortens the next search rather than exceeding request deadline", async t => {
  const advance = clock(t);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = fixture(t, (command, worker) => {
    if (command === "uci") { now = 2760; worker.emit("message", "uciok"); return true; }
    return false;
  });
  const result = await f.analyzer.analyze({ fen, candidates: ["d2d4"] });
  assert.equal(result.searches[0].requestedTimeMs, 15);
  assert.ok(result.searches.every(search => search.requestedTimeMs <= 200));
  await advance(0);
});

test("crash, early clean exit and protocol failures settle sanitized evidence and terminate", async t => {
  for (const mode of ["error", "exit", "protocol", "critical"]) {
    const f = fixture(t, (command, worker) => {
      if (!command.startsWith("go ")) return false;
      if (mode === "error") worker.emit("error", new Error("secret /private/path"));
      if (mode === "exit") worker.emit("exit", 0);
      if (mode === "protocol") worker.emit("message", "bestmove invalid");
      if (mode === "critical") worker.emit("message", "info string CRITICAL ERROR: /private/path");
      return true;
    });
    const result = await f.analyzer.analyze({ fen });
    assert.equal(result.partial, true);
    assert.match(result.reason, /^engine-(error|exit|protocol)$/);
    assert.doesNotMatch(JSON.stringify(result), /secret|private\/path/);
    assert.equal(f.workers[0].terminated, true);
  }
});

test("native abort and activation disable both await worker termination and refuse late calls", async t => {
  for (const mode of ["native", "activation", "dispose"]) {
    let release;
    const f = fixture(t, command => command === "uci", () => new Promise(resolve => { release = resolve; }));
    const native = new AbortController();
    let settled = false;
    const pending = f.analyzer.analyze({ fen }, native.signal).then(result => { settled = true; return result; });
    if (mode === "native") native.abort();
    if (mode === "activation") f.activation.abort();
    const disposal = mode === "dispose" ? f.analyzer.dispose() : undefined;
    await flush();
    assert.equal(settled, false);
    assert.equal(f.workers[0].terminationCalls, 1);
    release();
    const result = await pending;
    await disposal;
    assert.equal(result.reason, "cancelled");
    assert.equal(f.workers[0].terminated, true);
    if (mode !== "native") await assert.rejects(f.analyzer.analyze({ fen }), /cancelled/);
  }
});

test("error completion waits for termination; abort during successful teardown fences late success", async t => {
  for (const mode of ["error", "late-abort"]) {
    let release;
    const f = fixture(t, mode === "error" ? (command, worker) => {
      if (command !== "uci") return false;
      worker.emit("error", new Error("private detail"));
      return true;
    } : undefined, () => new Promise(resolve => { release = resolve; }));
    let settled = false;
    const pending = f.analyzer.analyze({ fen }).then(result => { settled = true; return result; });
    await flush();
    assert.equal(settled, false);
    assert.equal(f.workers[0].terminationCalls, 1);
    if (mode === "late-abort") f.activation.abort();
    release();
    const result = await pending;
    assert.equal(result.reason, mode === "error" ? "engine-error" : "cancelled");
    assert.equal(result.completed, false);
    assert.equal(f.workers[0].terminated, true);
  }
});

test("budget exhaustion after baseline retains completed evidence and lists untouched candidates", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = fixture(t, (command, worker) => {
    if (!command.startsWith("go ")) return false;
    worker.emit("message", info);
    now = 2790;
    worker.emit("message", "bestmove e2e4");
    return true;
  });
  const result = await f.analyzer.analyze({ fen, candidates: ["d2d4"] });
  assert.equal(result.reason, "request-budget");
  assert.equal(result.searches.length, 1);
  assert.equal(result.searches[0].completed, true);
  assert.deepEqual(result.unsearchedCandidates, ["d2d4"]);
  assert.equal(f.workers[0].terminated, true);
});

test("construction/termination errors settle without exposing raw paths", async t => {
  const analyzer = createAnalyzer("/not-used", new AbortController().signal, () => { throw new Error("/private/file"); });
  const result = await analyzer.analyze({ fen });
  assert.equal(result.reason, "engine-error");
  await analyzer.dispose();
  const f = fixture(t, undefined, () => { throw new Error("/private/terminate"); });
  const terminated = await f.analyzer.analyze({ fen });
  assert.equal(terminated.reason, "termination-error");
  assert.doesNotMatch(JSON.stringify(terminated), /private/);
});

test("pre-aborted requests create no worker and each new request creates a fresh worker", async t => {
  const f = fixture(t);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.analyzer.analyze({ fen }, aborted.signal), /cancelled/);
  assert.equal(f.workers.length, 0);
  await f.analyzer.analyze({ fen });
  await f.analyzer.analyze({ fen });
  assert.equal(f.workers.length, 2);
  assert.ok(f.workers.every(worker => worker.terminated && worker.terminationCalls === 1));
});
