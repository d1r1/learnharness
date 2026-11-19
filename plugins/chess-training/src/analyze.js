import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { startPosition, legalMove } from "./core.js";

const movePattern = "^[a-h][1-8][a-h][1-8][qrbn]?$";
const moveRegex = new RegExp(movePattern);
export const analysisSchema = {
  type: "object", additionalProperties: false, required: ["fen"],
  properties: {
    fen: { type: "string", minLength: 1, maxLength: 256 },
    candidates: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", pattern: movePattern } },
  },
};
export const engineBuild = Object.freeze({
  name: "Stockfish.js", version: "19.0.1", flavor: "lite-single",
  commit: "0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6",
  jsSha256: "ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a",
  wasmSha256: "ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de",
});

export function validateAnalysis(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["fen", "candidates"].includes(key))
    || typeof input.fen !== "string" || input.fen.length > 256 || /[\r\n]/.test(input.fen)) throw new Error("Analysis requires a full standard FEN and optional candidates only.");
  const pos = startPosition(input.fen);
  const candidates = input.candidates;
  if (candidates !== undefined && (!Array.isArray(candidates) || !candidates.length || candidates.length > 8
    || new Set(candidates).size !== candidates.length || candidates.some(move => !legalMove(pos, move)))) {
    throw new Error("Candidates must be 1–8 distinct legal standard UCI moves from the supplied FEN.");
  }
  return { fen: input.fen, candidates: candidates ? [...candidates] : [], perspective: pos.turn };
}

// Keep UCI root-side scores verbatim: searchmoves does not play the candidate first.
export function parseInfo(line, perspective) {
  if (typeof line !== "string" || line.length > 16384 || !line.startsWith("info ") || line.startsWith("info string ")) return undefined;
  const tokens = line.trim().split(/\s+/);
  const at = tokens.indexOf("score");
  if (at < 0 || !["cp", "mate"].includes(tokens[at + 1]) || !/^-?\d+$/.test(tokens[at + 2] ?? "")) return undefined;
  const value = Number(tokens[at + 2]);
  if (!Number.isSafeInteger(value)) return undefined;
  const number = key => {
    const index = tokens.indexOf(key);
    if (index < 0 || !/^\d+$/.test(tokens[index + 1] ?? "")) return null;
    const n = Number(tokens[index + 1]);
    return Number.isSafeInteger(n) ? n : null;
  };
  if (number("multipv") !== null && number("multipv") !== 1) return undefined;
  const pvIndex = tokens.indexOf("pv");
  const pv = pvIndex < 0 ? [] : tokens.slice(pvIndex + 1);
  if (pv.length > 256 || pv.some(move => !moveRegex.test(move))) return undefined;
  const bound = tokens[at + 3];
  return {
    score: { unit: tokens[at + 1], value, perspective,
      bound: bound === "lowerbound" || bound === "upperbound" ? bound : "exact" },
    depth: number("depth"), nodes: number("nodes"), timeMs: number("time"), pv,
  };
}

const failure = code => Object.assign(new Error(code), { analysisCode: code });

// Internal factory injection keeps ordinary tests independent of WASM speed; not a product option.
export function createAnalyzer(directory, activationSignal, createWorker = file => new Worker(file)) {
  let active;
  let disposed = false;
  return {
    async analyze(input, signal) {
      if (disposed || activationSignal?.aborted || signal?.aborted) throw new Error("Chess analysis cancelled.");
      if (active) throw new Error("Chess analysis is busy; retry after the active request finishes.");
      const request = validateAnalysis(input);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      activationSignal?.addEventListener("abort", cancel, { once: true });
      signal?.addEventListener("abort", cancel, { once: true });
      const promise = runAnalysis(directory, request, controller.signal, createWorker);
      active = { promise, cancel };
      try { return await promise; }
      finally {
        activationSignal?.removeEventListener("abort", cancel);
        signal?.removeEventListener("abort", cancel);
        active = undefined;
      }
    },
    async dispose() {
      disposed = true;
      const current = active;
      current?.cancel();
      await current?.promise;
    },
  };
}

async function runAnalysis(directory, request, signal, createWorker) {
  const started = performance.now();
  // Leave 200 ms of the 3 s request budget for awaited termination.
  const deadline = started + 2800;
  const searches = [];
  let worker;
  let waiting;
  let current;
  let reason = null;
  let ended = false;
  let failed;
  let deadlineTimer;
  let searchStop;
  let searchDeadline;
  let engineName = null;
  const fail = code => {
    if (ended || failed) return;
    failed = failure(code);
    waiting?.reject(failed);
  };
  const cancel = () => {
    try { worker?.postMessage("stop"); } catch { /* Termination below still owns cleanup. */ }
    fail("cancelled");
  };
  const onMessage = line => {
    if (ended || failed || typeof line !== "string") return;
    if (line.startsWith("id name ")) engineName = line.slice(8, 168);
    if (line.startsWith("info string CRITICAL ERROR")) return fail("engine-error");
    const info = current && parseInfo(line, request.perspective);
    if (info) current.evidence = info;
    if (waiting?.matches(line)) { const pending = waiting; waiting = undefined; pending.resolve(line); }
  };
  const onError = () => fail("engine-error");
  const onExit = () => fail("engine-exit");
  const command = (commands, matches) => new Promise((resolve, reject) => {
    if (failed) return reject(failed);
    waiting = { matches, resolve, reject };
    try { for (const text of commands) worker.postMessage(text); }
    catch { fail("engine-error"); }
  });
  try {
    deadlineTimer = setTimeout(() => fail("request-budget"), Math.max(1, deadline - performance.now()));
    worker = createWorker(join(directory, "engine-worker.cjs"));
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    await command(["uci"], line => line === "uciok");
    await command([
      "setoption name Threads value 1", "setoption name Hash value 16",
      "setoption name Ponder value false", "setoption name MultiPV value 1",
      "setoption name UCI_Chess960 value false", "isready",
    ], line => line === "readyok");
    for (const candidate of [null, ...request.candidates]) {
      if (failed) throw failed;
      const allowance = Math.min(200, Math.floor(deadline - performance.now()));
      if (allowance < 25) throw failure("request-budget");
      current = { candidate, completed: false, reason: null, requestedTimeMs: Math.max(1, allowance - 25), evidence: null, bestmove: null };
      searches.push(current);
      // Stop early enough to allow asynchronous single-thread WASM to yield; hard cutoff is parent-owned.
      searchStop = setTimeout(() => { try { worker.postMessage("stop"); } catch { fail("engine-error"); } }, allowance - 20);
      searchDeadline = setTimeout(() => fail("search-budget"), allowance);
      const best = await command([`position fen ${request.fen}`, `go movetime ${current.requestedTimeMs}${candidate ? ` searchmoves ${candidate}` : ""}`], line => line.startsWith("bestmove "));
      clearTimeout(searchStop);
      clearTimeout(searchDeadline);
      const move = best.split(/\s+/)[1];
      if (!(move === "(none)" || move === "0000" || moveRegex.test(move))
        || (candidate && move !== candidate)) throw failure("engine-protocol");
      current.bestmove = move === "(none)" || move === "0000" ? null : move;
      current.completed = current.evidence !== null;
      current.reason = current.completed ? null : "no-score-progress";
      current = undefined;
      // Readiness separates completed searches, rather than guessing from a late info line.
      await command(["isready"], line => line === "readyok");
    }
  } catch (error) {
    reason = error?.analysisCode ?? "engine-error";
    if (current) current.reason = reason;
  } finally {
    ended = true;
    waiting = undefined;
    clearTimeout(deadlineTimer);
    clearTimeout(searchStop);
    clearTimeout(searchDeadline);
    signal.removeEventListener("abort", cancel);
    if (worker) {
      try { worker.postMessage("stop"); } catch { /* An exited worker still needs awaited termination. */ }
      try { await worker.terminate(); }
      catch { reason = "termination-error"; }
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    }
  }
  // An abort during awaited teardown still fences an otherwise successful late completion.
  if (signal.aborted) reason = "cancelled";
  const elapsedMs = Math.ceil(performance.now() - started);
  if (elapsedMs > 3000 && reason === null) reason = "request-budget";
  const completed = reason === null && searches.length === request.candidates.length + 1 && searches.every(search => search.completed);
  return {
    kind: "engine-evidence", completed, partial: !completed,
    reason: reason ?? (completed ? null : "no-score-progress"),
    fen: request.fen, scorePerspective: request.perspective,
    engine: { ...engineBuild, reportedName: engineName },
    options: { Threads: 1, HashMiB: 16, Ponder: false, MultiPV: 1, UCI_Chess960: false },
    budget: { totalMs: 3000, perSearchMs: 200 }, elapsedMs,
    searches, unsearchedCandidates: request.candidates.filter(candidate => !searches.some(search => search.candidate === candidate)),
    limitations: "Finite-budget lite-engine evidence, not a grade, proof of uniqueness or guarantee. FEN has no repetition history. Scores are from the supplied FEN side to move, including restricted searches; cp and mate are distinct units. Bounds are not exact scores. Missing alternatives do not establish uniqueness.",
  };
}
