import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engineBuild } from "../src/analyze.js";

const engine = new URL("../engine/", import.meta.url);
const source = "source/stockfish.js-0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6.tar.gz";
test("official engine hashes and exact corresponding source/network are pinned and shipped offline", async () => {
  for (const [file, expected] of [
    ["stockfish-19-lite-single.js", engineBuild.jsSha256],
    ["stockfish-19-lite-single.wasm", engineBuild.wasmSha256],
    [source, "e5289a920554bf0069a6601c228e81d957c00522bb31c4343588dc5d7d251879"],
    ["source/nn-61e7af4bb97d.nnue", "61e7af4bb97d51eeeb25d322916f86513b5cd3a827ce189c98c6e31946f99e5b"],
  ]) {
    assert.equal(createHash("sha256").update(await readFile(new URL(file, engine))).digest("hex"), expected, file);
  }
  const archive = execFileSync("tar", ["-tzf", fileURLToPath(new URL(source, engine))], { encoding: "utf8" }).split("\n");
  for (const file of ["Copying.txt", "AUTHORS", "README.md", "build.js", "src/Makefile", "src/uci.cpp", "src/search.cpp", "src/score.cpp", "src/emscripten/wasm-makefile.mk", "src/emscripten/credits-lite.js", "scripts/net.sh"]) {
    assert.ok(archive.includes(`stockfish.js-${engineBuild.commit}/${file}`), file);
  }
  assert.deepEqual((await readdir(engine)).filter(file => /\.(wasm|js)$/.test(file)).sort(), ["stockfish-19-lite-single.js", "stockfish-19-lite-single.wasm"]);
  const policy = await readFile(new URL("source/fishtest-network-upload-policy.html.j2", engine), "utf8");
  assert.match(policy, /By uploading, you license your network/);
  assert.match(policy, /CC0/);
  for (const file of ["stockfish-GPL-3.0.txt", "stockfish-network-CC0.txt"]) {
    assert.ok((await readFile(new URL(`../licenses/${file}`, import.meta.url), "utf8")).length > 6000);
  }
});
