import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStore } from "../src/store.js";
import { initialState } from "../src/core.js";

const identity = { chatId: "chat/../../untrusted", questionId: "question/../exact", contractVersion: 1 };
const puzzle = () => ({
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  lines: [["e2e4", "e7e5", "g1f3"]],
  hints: [["First hint", "More detail"], ["Develop a knight"]],
});
const move = uci => ({ type: "move", uci });
const hint = { type: "hint" };
const act = (store, opened, event, payload = puzzle(), target = identity) => store.act({ identity: target, payload, lease: opened.lease, revision: opened.revision, event });

async function fixture(t, options) {
  const directory = await fs.mkdtemp(join(tmpdir(), "chess-store-"));
  const stores = [];
  const create = opts => { const store = createStore(directory, opts); stores.push(store); return store; };
  t.after(async () => {
    for (const store of stores) await store.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store: create(options), create, async path() {
    const names = await fs.readdir(join(directory, "puzzles"));
    assert.equal(names.length, 1);
    assert.match(names[0], /^[a-f0-9]{64}\.json$/);
    return join(directory, "puzzles", names[0]);
  } };
}

// Preserve FileHandle receivers while replacing one operation.
function wrapHandle(handle, overrides) {
  return new Proxy(handle, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("open creates only initial state, hashes identity, and restores all evidence after restart", async t => {
  const f = await fixture(t);
  let opened = await f.store.open(identity, puzzle());
  assert.deepEqual(opened.state, initialState());
  assert.equal(opened.revision, 0);
  opened = await act(f.store, opened, hint);
  opened = await act(f.store, opened, move("d2d4"));
  assert.equal(opened.accepted, false);
  opened = await act(f.store, opened, move("e2e4"));
  assert.equal(opened.accepted, true);
  assert.deepEqual(opened.state.moves, ["e2e4", "e7e5"]);
  const path = await f.path();
  const bytes = await fs.readFile(path, "utf8");
  const record = JSON.parse(bytes);
  assert.equal(record.version, 1);
  assert.deepEqual(record.identity, identity);
  assert.deepEqual(record.payload, puzzle());
  assert.equal(record.revision, 3);
  assert.equal(Object.hasOwn(record, "lease"), false);
  await f.store.dispose();
  const restarted = f.create();
  await assert.rejects(act(restarted, opened, hint), /lease/);
  const restored = await restarted.open(identity, puzzle());
  assert.deepEqual(restored.state, opened.state);
  assert.equal(restored.revision, 3);
  assert.notEqual(restored.lease, opened.lease);
  assert.equal(await fs.readFile(path, "utf8"), bytes);
  const completed = await act(restarted, restored, move("g1f3"));
  assert.equal(completed.feedback, "Puzzle complete.");
  assert.equal((await fs.readdir(join(f.directory, "puzzles"))).length, 1);
});

test("missing dataDirectory is refused without creating it or its ancestors", async t => {
  const f = await fixture(t);
  const missingAncestor = join(f.directory, "missing");
  const store = createStore(join(missingAncestor, "data"));
  t.after(() => store.dispose());
  await assert.rejects(store.open(identity, puzzle()), { code: "ENOENT" });
  await assert.rejects(fs.stat(missingAncestor), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("dataDirectory must stat as a directory and only puzzles is created nonrecursively", async t => {
  const calls = [];
  const f = await fixture(t, { io: {
    async stat(path) { calls.push(["stat", path]); return fs.stat(path); },
    async mkdir(...args) { calls.push(["mkdir", ...args]); return fs.mkdir(...args); },
  } });
  await f.store.open(identity, puzzle());
  assert.deepEqual(calls, [["stat", f.directory], ["mkdir", join(f.directory, "puzzles")]]);
  const file = join(f.directory, "not-a-directory");
  await fs.writeFile(file, "unchanged");
  const store = createStore(file);
  t.after(() => store.dispose());
  await assert.rejects(store.open(identity, puzzle()), /existing directory|ENOTDIR/);
  assert.equal(await fs.readFile(file, "utf8"), "unchanged");
});

test("concurrent same-revision updates admit one and never lose a write", async t => {
  const { store } = await fixture(t);
  const opened = await store.open(identity, puzzle());
  const outcomes = await Promise.allSettled([act(store, opened, hint), act(store, opened, move("e2e4"))]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.match(outcomes.find(result => result.status === "rejected").reason.message, /revision/);
  const restored = await store.open(identity, puzzle());
  assert.equal(restored.revision, 1);
  assert.deepEqual(restored.state.revealedHints, [{ learnerMove: 0, count: 1 }]);
  assert.deepEqual(restored.state.moves, []);
});

test("remount fences old leases, including open racing with act and simultaneous opens", async t => {
  const { store } = await fixture(t);
  const first = await store.open(identity, puzzle());
  const opening = store.open(identity, puzzle());
  const stale = act(store, first, move("e2e4"));
  const second = await opening;
  await assert.rejects(stale, /lease/);
  assert.equal(second.revision, 0);
  const [third, fourth] = await Promise.all([store.open(identity, puzzle()), store.open(identity, puzzle())]);
  await assert.rejects(act(store, second, hint), /lease/);
  await assert.rejects(act(store, third, hint), /lease/);
  assert.equal((await act(store, fourth, hint)).revision, 1);
});

test("updates queued before remount finish before it reads durable state", async t => {
  const { store } = await fixture(t);
  const first = await store.open(identity, puzzle());
  const updating = act(store, first, move("e2e4"));
  const opening = store.open(identity, puzzle());
  await updating;
  const second = await opening;
  assert.equal(second.revision, 1);
  assert.deepEqual(second.state.moves, ["e2e4", "e7e5"]);
  await assert.rejects(act(store, { ...first, revision: 1 }, hint), /lease/);
});

test("identity separates questions and payload binding includes exact hint text and line order", async t => {
  const f = await fixture(t);
  const opened = await f.store.open(identity, puzzle());
  const path = await f.path();
  const bytes = await fs.readFile(path, "utf8");
  const changed = puzzle();
  changed.hints[0][0] += " ";
  await assert.rejects(f.store.open(identity, changed), /payload mismatch/);
  await assert.rejects(act(f.store, opened, hint, changed), /payload mismatch/);
  assert.equal(await fs.readFile(path, "utf8"), bytes);
  const other = { ...identity, questionId: "different stable occurrence" };
  assert.deepEqual((await f.store.open(other, changed)).state, initialState());
  assert.equal((await fs.readdir(join(f.directory, "puzzles"))).length, 2);
  const alternatives = { ...puzzle(), lines: [["e2e4", "e7e5", "g1f3"], ["d2d4", "d7d5", "c2c4"]] };
  const third = { ...identity, questionId: "alternatives" };
  await f.store.open(third, alternatives);
  await assert.rejects(f.store.open(third, { ...alternatives, lines: [...alternatives.lines].reverse() }), /payload mismatch/);
});

for (const [name, corrupt] of [
  ["invalid JSON", () => "{"],
  ["newer schema", record => JSON.stringify({ ...record, version: 2 })],
  ["invalid revision", record => JSON.stringify({ ...record, revision: -1 })],
  ["identity mismatch", record => JSON.stringify({ ...record, identity: { ...identity, questionId: "wrong" } })],
  ["payload fingerprint", record => JSON.stringify({ ...record, payload: { ...record.payload, hints: [["Edited", "More detail"], ["Develop a knight"]] } })],
  ["forged state", record => JSON.stringify({ ...record, state: { ...record.state, moves: ["d2d4", "d7d5"] } })],
  ["unknown fields", record => JSON.stringify({ ...record, extra: true })],
]) {
  test(`persisted ${name} fails closed without resetting or overwriting`, async t => {
    const f = await fixture(t);
    const opened = await f.store.open(identity, puzzle());
    const path = await f.path();
    const bad = corrupt(JSON.parse(await fs.readFile(path, "utf8")));
    await fs.writeFile(path, bad);
    await assert.rejects(f.store.open(identity, puzzle()));
    await assert.rejects(act(f.store, opened, hint));
    await assert.rejects(f.create().open(identity, puzzle()));
    assert.equal(await fs.readFile(path, "utf8"), bad);
  });
}

for (const stage of ["write", "file-sync", "rename", "directory-sync", "data-sync", "parent-sync"]) {
  test(`atomic ${stage} failure rejects and cleans temporary files`, async t => {
    let fail = false;
    let dataDirectory;
    const syncs = [];
    const directoryFailure = ["directory-sync", "data-sync", "parent-sync"].includes(stage);
    const io = {
      async open(path, ...args) {
        const handle = await fs.open(path, ...args);
        return wrapHandle(handle, {
          async writeFile(...values) {
            if (fail && stage === "write") { await handle.writeFile("partial"); throw new Error("Injected write"); }
            return handle.writeFile(...values);
          },
          async sync() {
            const syncStage = args[0] === "wx" ? "file-sync"
              : path === dataDirectory ? "data-sync"
              : path === dirname(dataDirectory) ? "parent-sync" : "directory-sync";
            syncs.push(syncStage);
            if (fail && stage === syncStage) throw new Error("Injected sync");
            return handle.sync();
          },
        });
      },
      async rename(...args) { if (fail && stage === "rename") throw new Error("Injected rename"); return fs.rename(...args); },
    };
    const f = await fixture(t, { io });
    dataDirectory = f.directory;
    const opened = await f.store.open(identity, puzzle());
    const path = await f.path();
    const before = await fs.readFile(path, "utf8");
    fail = true;
    await assert.rejects(act(f.store, opened, move("e2e4")), /Injected/);
    await f.path(); // exactly one JSON file; no temporary residue
    const after = await fs.readFile(path, "utf8");
    if (!directoryFailure) assert.equal(after, before);
    else {
      // Rename already committed: report failure, never pretend it did not happen or replay it.
      assert.deepEqual(JSON.parse(after).state.moves, ["e2e4", "e7e5"]);
      assert.equal(JSON.parse(after).revision, 1);
      await assert.rejects(f.store.open(identity, puzzle()), /Injected sync/);
      // A failed remount must not replace the prior lease.
      await assert.rejects(act(f.store, opened, hint), /revision/);
    }
    fail = false;
    if (directoryFailure) await assert.rejects(act(f.store, opened, hint), /revision/);
    const restored = await f.store.open(identity, puzzle());
    assert.equal(restored.revision, directoryFailure ? 1 : 0);
    syncs.length = 0;
    assert.equal((await act(f.store, restored, hint)).revision, restored.revision + 1);
    assert.deepEqual(syncs, ["file-sync", "directory-sync", "data-sync", "parent-sync"]);
  });
}

test("every atomic write flushes the file before rename and all owning directories after it", async t => {
  const calls = [];
  let dataDirectory;
  const f = await fixture(t, { io: {
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      const kind = args[0] === "wx" ? "file"
        : path === dataDirectory ? "data"
        : path === dirname(dataDirectory) ? "parent" : "directory";
      calls.push(`open-${kind}`);
      if (kind === "file") assert.equal(args[1], 0o600);
      return wrapHandle(handle, {
        async writeFile(...values) { calls.push("write"); return handle.writeFile(...values); },
        async sync() { calls.push(`sync-${kind}`); return handle.sync(); },
        async close() { calls.push(`close-${kind}`); return handle.close(); },
      });
    },
    async rename(...args) { calls.push("rename"); return fs.rename(...args); },
  } });
  dataDirectory = f.directory;
  const expected = ["open-file", "write", "sync-file", "close-file", "rename",
    "open-directory", "sync-directory", "close-directory",
    "open-data", "sync-data", "close-data", "open-parent", "sync-parent", "close-parent"];
  const opened = await f.store.open(identity, puzzle());
  assert.deepEqual(calls, expected);
  calls.length = 0;
  await act(f.store, opened, hint);
  assert.deepEqual(calls, expected);
});

test("open durably reconciles a renamed record only after all owners sync, without rewriting", async t => {
  let fail = false;
  let dataDirectory;
  const calls = [];
  const f = await fixture(t, { io: {
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      const kind = args[0] === "wx" ? "file"
        : path === dataDirectory ? "data"
        : path === dirname(dataDirectory) ? "parent" : "directory";
      calls.push(`open-${kind}`);
      return wrapHandle(handle, {
        async writeFile(...values) { calls.push("write"); return handle.writeFile(...values); },
        async sync() {
          calls.push(`sync-${kind}`);
          if (fail && kind === "parent") throw new Error("Injected parent sync");
          return handle.sync();
        },
        async close() { calls.push(`close-${kind}`); return handle.close(); },
      });
    },
    async rename(...args) { calls.push("rename"); return fs.rename(...args); },
  } });
  dataDirectory = f.directory;
  const opened = await f.store.open(identity, puzzle());
  fail = true;
  calls.length = 0;
  await assert.rejects(act(f.store, opened, move("e2e4")), /Injected parent sync/);
  assert.ok(calls.indexOf("rename") < calls.indexOf("sync-parent"));
  const path = await f.path();
  const bytes = await fs.readFile(path, "utf8");
  assert.equal(JSON.parse(bytes).revision, 1);
  const owners = ["open-directory", "sync-directory", "close-directory",
    "open-data", "sync-data", "close-data", "open-parent", "sync-parent", "close-parent"];
  calls.length = 0;
  await assert.rejects(f.store.open(identity, puzzle()), /Injected parent sync/);
  assert.deepEqual(calls, owners);
  await assert.rejects(act(f.store, opened, hint), /revision/);
  fail = false;
  calls.length = 0;
  const restored = await f.store.open(identity, puzzle()).then(result => {
    calls.push("ack");
    return result;
  });
  assert.deepEqual(calls, [...owners, "ack"]);
  assert.equal(restored.revision, 1);
  assert.deepEqual(restored.state.moves, ["e2e4", "e7e5"]);
  assert.notEqual(restored.lease, opened.lease);
  assert.equal(await fs.readFile(path, "utf8"), bytes);
  await f.path();
});

for (const cancellation of ["abort", "dispose"]) {
  for (const stage of ["open", "sync", "close"]) {
    test(`existing-record owner ${stage} ${cancellation} closes handles and rejects open`, async t => {
      const controller = new AbortController();
      let cancel = false;
      let store;
      const calls = [];
      function cancelAt(point) {
        if (!cancel || stage !== point) return;
        if (cancellation === "abort") controller.abort();
        else void store.dispose();
      }
      const f = await fixture(t, { signal: controller.signal, io: {
        async open(path, ...args) {
          const handle = await fs.open(path, ...args);
          if (args[0] !== "r") return handle;
          calls.push("open");
          cancelAt("open");
          return wrapHandle(handle, {
            async sync() { calls.push("sync"); await handle.sync(); cancelAt("sync"); },
            async close() { calls.push("close"); await handle.close(); cancelAt("close"); },
          });
        },
      } });
      store = f.store;
      await store.open(identity, puzzle());
      const path = await f.path();
      const bytes = await fs.readFile(path, "utf8");
      cancel = true;
      calls.length = 0;
      await assert.rejects(store.open(identity, puzzle()), /closed or aborted/);
      assert.deepEqual(calls, stage === "open" ? ["open", "close"] : ["open", "sync", "close"]);
      assert.equal(await fs.readFile(path, "utf8"), bytes);
    });
  }
}

test("read errors other than absence do not reset or overwrite records", async t => {
  let fail = false;
  const f = await fixture(t, { io: { async readFile(...args) {
    if (fail) throw Object.assign(new Error("Injected read failure"), { code: "EACCES" });
    return fs.readFile(...args);
  } } });
  const opened = await f.store.open(identity, puzzle());
  const path = await f.path();
  const before = await fs.readFile(path, "utf8");
  fail = true;
  await assert.rejects(f.store.open(identity, puzzle()), /Injected read failure/);
  await assert.rejects(act(f.store, opened, hint), /Injected read failure/);
  assert.equal(await fs.readFile(path, "utf8"), before);
});

test("already-aborted store never creates puzzle storage", async t => {
  const controller = new AbortController();
  controller.abort();
  const f = await fixture(t, { signal: controller.signal });
  await assert.rejects(f.store.open(identity, puzzle()), /aborted/);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("failed initial creation leaves no record and a later open can retry", async t => {
  let fail = true;
  const f = await fixture(t, { io: { async rename(...args) { if (fail) throw new Error("Injected rename"); return fs.rename(...args); } } });
  await assert.rejects(f.store.open(identity, puzzle()), /Injected/);
  assert.deepEqual(await fs.readdir(join(f.directory, "puzzles")), []);
  fail = false;
  assert.equal((await f.store.open(identity, puzzle())).revision, 0);
});

test("invalid identities, events, CAS fields and arbitrary state fail without writes", async t => {
  const f = await fixture(t);
  for (const bad of [null, {}, { ...identity, contractVersion: 2 }, { ...identity, chatId: " " }, { ...identity, questionId: 1 }, { ...identity, occurrence: {} }]) {
    await assert.rejects(f.store.open(bad, puzzle()));
  }
  await assert.rejects(f.store.open(identity, { ...puzzle(), fen: "bad" }));
  const opened = await f.store.open(identity, puzzle());
  const path = await f.path();
  const before = await fs.readFile(path, "utf8");
  for (const event of [null, {}, { type: "reset" }, { type: "hint", state: initialState() }, { type: "move", uci: 42 }, { type: "move" }]) {
    await assert.rejects(act(f.store, opened, event));
  }
  const request = { identity, payload: puzzle(), lease: opened.lease, revision: 0, event: hint };
  for (const changes of [{ lease: "" }, { lease: "forged" }, { revision: -1 }, { revision: 0.5 }, { revision: 1 }, { state: initialState() }, { identity: null }]) {
    await assert.rejects(f.store.act({ ...request, ...changes }));
  }
  assert.equal(await fs.readFile(path, "utf8"), before);
  const incorrect = await act(f.store, opened, move("not-uci"));
  assert.equal(incorrect.accepted, false);
  assert.deepEqual(incorrect.state.incorrectAttempts, [{ atPly: 0, move: "not-uci" }]);
});

for (const stage of ["read", "file-sync", "rename"]) {
  test(`abort after awaited ${stage} fences publication and pre-commit writes`, async t => {
    const controller = new AbortController();
    let abort = false;
    const io = {
      async readFile(...args) { const data = await fs.readFile(...args); if (abort && stage === "read") controller.abort(); return data; },
      async open(...args) {
        const handle = await fs.open(...args);
        return wrapHandle(handle, { async sync() { await handle.sync(); if (abort && stage === "file-sync" && args[1] === "wx") controller.abort(); } });
      },
      async rename(...args) { await fs.rename(...args); if (abort && stage === "rename") controller.abort(); },
    };
    const f = await fixture(t, { signal: controller.signal, io });
    const opened = await f.store.open(identity, puzzle());
    const path = await f.path();
    const before = await fs.readFile(path, "utf8");
    abort = true;
    await assert.rejects(act(f.store, opened, move("e2e4")), /aborted/);
    await assert.rejects(f.store.open(identity, puzzle()), /aborted/);
    await f.path();
    if (stage !== "rename") assert.equal(await fs.readFile(path, "utf8"), before);
    else assert.equal(JSON.parse(await fs.readFile(path, "utf8")).revision, 1);
  });
}

test("dispose invalidates queued work and leaves existing data intact", async t => {
  const f = await fixture(t);
  const opened = await f.store.open(identity, puzzle());
  const path = await f.path();
  const before = await fs.readFile(path, "utf8");
  const pending = act(f.store, opened, hint);
  const disposed = f.store.dispose();
  await assert.rejects(pending, /closed/);
  await disposed;
  await assert.rejects(f.store.open(identity, puzzle()), /closed/);
  assert.equal(await fs.readFile(path, "utf8"), before);
});

test("caller mutation cannot change queued input or store-owned persisted state", async t => {
  const { store } = await fixture(t);
  const payload = puzzle();
  const target = { ...identity };
  const pending = store.open(target, payload);
  target.questionId = "changed";
  payload.hints[0][0] = "changed";
  const opened = await pending;
  opened.state.moves.push("forged");
  const again = await store.open(identity, puzzle());
  assert.deepEqual(again.state, initialState());
  const request = { identity: { ...identity }, payload: puzzle(), lease: again.lease, revision: 0, event: move("e2e4") };
  const acting = store.act(request);
  request.event.uci = "d2d4";
  request.payload.lines[0][0] = "d2d4";
  assert.deepEqual((await acting).state.moves, ["e2e4", "e7e5"]);
});
