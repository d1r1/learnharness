import * as filesystem from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validatePuzzle, validateState, initialState, attemptMove, revealHint } from "./core.js";

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function keys(value, expected, label) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)),
  `${label} must contain only ${expected.join(", ")}.`);
}

function validateIdentity(identity) {
  keys(identity, ["chatId", "questionId", "contractVersion"], "Identity");
  requireThat(typeof identity.chatId === "string" && identity.chatId.trim().length > 0
    && typeof identity.questionId === "string" && identity.questionId.trim().length > 0
    && identity.contractVersion === 1, "Identity requires nonblank chatId, questionId and contractVersion 1.");
}

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Object property ordering is not payload content; all authored strings and array order are exact.
const fingerprint = payload => digest([payload.fen, payload.lines, payload.hints]);
const identityKey = identity => digest([identity.chatId, identity.questionId, identity.contractVersion]);

/** io optionally overrides node:fs/promises operations for deterministic failure tests. */
export function createStore(dataDirectory, { signal, io = {} } = {}) {
  const fs = { ...filesystem, ...io };
  const directory = join(dataDirectory, "puzzles");
  const leases = new Map();
  let closed = false;
  let tail = Promise.resolve();

  function fence() {
    requireThat(!closed && !signal?.aborted, "Chess puzzle store is closed or aborted.");
  }

  // One queue covers both mounts and updates, including the complete atomic write.
  function serialize(operation) {
    const result = tail.then(() => { fence(); return operation(); });
    tail = result.catch(() => {});
    return result;
  }

  async function checked(operation) {
    fence();
    const result = await operation();
    fence();
    return result;
  }

  async function syncOwners() {
    // Reconfirm all owners even after an earlier post-rename sync failed:
    // puzzles owns the record, dataDirectory owns puzzles, and its parent owns
    // the host-created dataDirectory entry (the host mkdir does not fsync it).
    for (const owner of [directory, dataDirectory, dirname(dataDirectory)]) {
      let dir;
      try {
        fence();
        dir = await fs.open(owner, "r");
        fence();
        await checked(() => dir.sync());
      } finally {
        // Opening or syncing may race cancellation; always close acquired handles.
        if (dir) await dir.close();
      }
      fence();
    }
  }

  async function atomicWrite(path, record) {
    const dataStat = await checked(() => fs.stat(dataDirectory));
    requireThat(dataStat.isDirectory(), "Puzzle dataDirectory must be an existing directory.");
    try { await checked(() => fs.mkdir(directory)); }
    catch (error) {
      fence();
      if (error.code !== "EEXIST") throw error;
    }
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let file;
    try {
      fence();
      file = await fs.open(temporary, "wx", 0o600);
      fence();
      await checked(() => file.writeFile(`${JSON.stringify(record)}\n`, "utf8"));
      await checked(() => file.sync());
      await file.close();
      file = undefined;
      fence();
      await checked(() => fs.rename(temporary, path));
      await syncOwners();
    } finally {
      // Cleanup must run even after cancellation. A post-rename failure is not reported as success.
      try { if (file) await file.close(); }
      finally {
        try { await fs.unlink(temporary); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    fence();
  }

  async function readRecord(identity, payload) {
    const path = join(directory, `${identityKey(identity)}.json`);
    let text;
    try { text = await checked(() => fs.readFile(path, "utf8")); }
    catch (error) {
      fence();
      if (error.code === "ENOENT") return { path, record: null };
      throw error;
    }
    let record;
    try { record = JSON.parse(text); }
    catch { throw new Error("Corrupt puzzle record: invalid JSON."); }
    requireThat(record?.version === 1, "Unsupported puzzle record version; refusing to overwrite.");
    keys(record, ["version", "identity", "payload", "fingerprint", "state", "revision"], "Puzzle record");
    validateIdentity(record.identity);
    requireThat(isDeepStrictEqual(record.identity, identity), "Puzzle record identity mismatch.");
    validatePuzzle(record.payload);
    requireThat(record.fingerprint === fingerprint(record.payload), "Corrupt puzzle record fingerprint.");
    requireThat(record.fingerprint === fingerprint(payload) && isDeepStrictEqual(record.payload, payload), "Puzzle payload mismatch for this question identity.");
    requireThat(Number.isSafeInteger(record.revision) && record.revision >= 0, "Corrupt puzzle record revision.");
    validateState(record.payload, record.state);
    return { path, record };
  }

  function snapshotRequest(identity, payload) {
    validateIdentity(identity);
    validatePuzzle(payload);
    return { identity: structuredClone(identity), payload: structuredClone(payload) };
  }

  return {
    async open(identity, payload) {
      const request = snapshotRequest(identity, payload);
      return serialize(async () => {
        const { identity, payload } = request;
        let { path, record } = await readRecord(identity, payload);
        fence();
        if (!record) {
          record = { version: 1, identity, payload, fingerprint: fingerprint(payload), state: initialState(), revision: 0 };
          await atomicWrite(path, record);
        } else {
          // A readable record may be an uncertain commit whose rename was never
          // durably synced. Reconfirm it before acknowledging it with a lease.
          await syncOwners();
        }
        fence();
        const lease = randomUUID();
        leases.set(identityKey(identity), lease);
        return { lease, revision: record.revision, state: record.state };
      });
    },

    async act(request) {
      keys(request, ["identity", "payload", "lease", "revision", "event"], "Action");
      const { identity, payload } = snapshotRequest(request.identity, request.payload);
      const { lease, revision } = request;
      requireThat(typeof lease === "string" && lease.length > 0, "Action lease must be a nonempty string.");
      requireThat(Number.isSafeInteger(revision) && revision >= 0, "Action revision must be a nonnegative safe integer.");
      const event = structuredClone(request.event);
      if (event?.type === "move") {
        keys(event, ["type", "uci"], "Move event");
        requireThat(typeof event.uci === "string", "Move UCI must be a string.");
      } else {
        keys(event, ["type"], "Hint event");
        requireThat(event.type === "hint", "Unknown puzzle event type.");
      }
      return serialize(async () => {
        requireThat(leases.get(identityKey(identity)) === lease, "Stale puzzle lease; reopen the puzzle.");
        const { path, record } = await readRecord(identity, payload);
        fence();
        requireThat(record && record.revision === revision, "Stale puzzle revision; reopen the puzzle.");
        requireThat(revision < Number.MAX_SAFE_INTEGER, "Puzzle revision exhausted.");
        const result = event.type === "move"
          ? attemptMove(payload, record.state, event.uci)
          : { state: revealHint(payload, record.state), feedback: "Hint requested." };
        const next = { ...record, state: result.state, revision: revision + 1 };
        validateState(payload, next.state);
        await atomicWrite(path, next);
        fence();
        return { lease, revision: next.revision, ...result };
      });
    },

    async dispose() {
      closed = true;
      leases.clear();
      await tail;
    },
  };
}
