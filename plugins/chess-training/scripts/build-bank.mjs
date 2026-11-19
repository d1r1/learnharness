// Builds the bundled puzzle and opening banks from the Lichess CC0 datasets.
// Usage: node scripts/build-bank.mjs <lichess_db_puzzle.csv> <dir with chess-openings a.tsv..e.tsv>
// Sources: https://database.lichess.org/#puzzles and https://github.com/lichess-org/chess-openings
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { makeUci } from "chessops/util";
import { Chess, castlingSide } from "chessops/chess";
import { startPosition } from "../src/core.js";
import { playUci } from "../src/bank.js";

const [puzzleCsv, openingsDir] = process.argv.slice(2);
if (!puzzleCsv || !openingsDir) throw new Error("Usage: node scripts/build-bank.mjs <lichess_db_puzzle.csv> <chess-openings dir>");
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bank");

// Selection: well-tested puzzles only, a random sample per 200-point rating band, plus extra
// opening-tagged puzzles so every opening family has material. Lichess ids are random, so file
// order is already a uniform sample.
const PER_BAND = 1500, PER_OPENING_FAMILY = 40;
const accepted = (deviation, popularity, plays) => deviation <= 80 && popularity >= 85 && plays >= 1000;

const bands = new Map(), families = new Map(), rows = [];
let read = 0, rejected = 0;
const lines = readline.createInterface({ input: createReadStream(puzzleCsv), crlfDelay: Infinity });
for await (const line of lines) {
  if (read++ === 0) { if (!line.startsWith("PuzzleId,FEN,Moves,Rating")) throw new Error("Unexpected puzzle CSV header"); continue; }
  const [id, fen, moves, rating, deviation, popularity, plays, themes, , openingTags = ""] = line.split(",");
  if (!accepted(Number(deviation), Number(popularity), Number(plays))) continue;
  const band = Math.min(2800, Math.max(400, Math.floor(Number(rating) / 200) * 200));
  const family = openingTags.split(" ")[0];
  const bandFull = (bands.get(band) ?? 0) >= PER_BAND;
  const familyWanted = family && (families.get(family) ?? 0) < PER_OPENING_FAMILY;
  if (bandFull && !familyWanted) continue;
  let learnerFen, solution;
  try {
    // Lichess FEN is before the opponent's setup move; the learner starts after it.
    const pos = startPosition(fen);
    const all = moves.split(" ");
    playUci(pos, all[0]);
    learnerFen = makeFen(pos.toSetup());
    solution = all.slice(1);
    if (solution.length % 2 !== 1) throw new Error("solution must end on a learner move");
    const check = startPosition(learnerFen);
    for (const uci of solution) playUci(check, uci);
  } catch { rejected++; continue; }
  bands.set(band, (bands.get(band) ?? 0) + 1);
  if (family) families.set(family, (families.get(family) ?? 0) + 1);
  rows.push([id, learnerFen, solution.join(" "), rating, themes, openingTags].join("\t"));
}

const openings = [];
for (const file of ["a", "b", "c", "d", "e"]) {
  const text = await readFile(path.join(openingsDir, `${file}.tsv`), "utf8");
  for (const [index, line] of text.split("\n").entries()) {
    if (index === 0 || !line) continue;
    const [eco, name, pgn] = line.split("\t");
    const pos = Chess.default();
    const uci = [];
    for (const san of pgn.split(" ").filter(token => !/^\d+\.$/.test(token))) {
      const move = parseSan(pos, san);
      if (!move) throw new Error(`Illegal SAN ${san} in ${eco} ${name}`);
      // The plugin's UCI uses the king's destination for castling (e1g1), not chessops' king-takes-rook form.
      const side = castlingSide(pos, move);
      uci.push(side ? makeUci({ from: move.from, to: (pos.turn === "white" ? 0 : 56) + (side === "h" ? 6 : 2) }) : makeUci(move));
      pos.play(move);
    }
    const check = Chess.default();
    for (const step of uci) playUci(check, step);
    openings.push([eco, name, uci.join(" ")].join("\t"));
  }
}

await mkdir(out, { recursive: true });
await writeFile(path.join(out, "puzzles.tsv"), rows.join("\n") + "\n");
await writeFile(path.join(out, "openings.tsv"), openings.join("\n") + "\n");
console.log(JSON.stringify({ read: read - 1, puzzles: rows.length, rejected, openingFamilies: families.size, bands: Object.fromEntries([...bands].sort((a, b) => a[0] - b[0])), openings: openings.length }));
