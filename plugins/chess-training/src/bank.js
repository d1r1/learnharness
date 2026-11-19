import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSquare } from "chessops/util";
import { makeFen } from "chessops/fen";
import { Chess } from "chessops/chess";
import { startPosition, legalMove } from "./core.js";

// Bundled read-only datasets built by scripts/build-bank.mjs from the Lichess CC0 exports.
const PUZZLES = "bank/puzzles.tsv";
const OPENINGS = "bank/openings.tsv";
const MAX_PUZZLES = 5;
const MAX_OPENINGS = 10;

export const puzzleSearchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    themes: { type: "array", maxItems: 4, items: { type: "string", pattern: "^[A-Za-z0-9]{2,40}$" }, description: "Lichess theme keys that must all be present, e.g. fork, pin, mateIn2, opening, endgame, hangingPiece." },
    opening: { type: "string", minLength: 2, maxLength: 80, description: "Opening name fragment matched against the puzzle's opening tags, e.g. 'Sicilian', 'Italian Game', 'Queens Gambit Declined'." },
    ratingMin: { type: "integer", minimum: 0, maximum: 4000 },
    ratingMax: { type: "integer", minimum: 0, maximum: 4000 },
    count: { type: "integer", minimum: 1, maximum: MAX_PUZZLES },
    exclude: { type: "array", maxItems: 200, items: { type: "string", pattern: "^[A-Za-z0-9]{3,12}$" }, description: "Puzzle ids already used in this conversation." },
  },
};

export const openingSearchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 2, maxLength: 80, description: "Opening name fragment ('Caro-Kann', 'Ruy Lopez: Berlin') or ECO code ('B12', 'C6')." },
    limit: { type: "integer", minimum: 1, maximum: MAX_OPENINGS },
  },
};

const PIECE_NAMES = { pawn: "pawn", knight: "knight", bishop: "bishop", rook: "rook", queen: "queen", king: "king" };
// First-hint wording per Lichess theme, most specific first; the hint names the idea, not the move.
const THEME_HINTS = [
  ["mateIn1", "There is a checkmate in one move."],
  ["mateIn2", "You can force checkmate in two moves."],
  ["mateIn3", "You can force checkmate in three moves."],
  ["mateIn4", "You can force checkmate in four moves."],
  ["backRankMate", "The enemy king is weak on its back rank."],
  ["smotheredMate", "The enemy king is boxed in by its own pieces."],
  ["fork", "Look for a move that attacks two targets at once."],
  ["pin", "Look for a piece that cannot move without exposing something more valuable."],
  ["skewer", "Attack a valuable piece that is standing in front of another one."],
  ["discoveredAttack", "Moving one piece can unmask an attack by another."],
  ["doubleCheck", "Look for a move that gives check with two pieces at once."],
  ["deflection", "Lure a defender away from what it protects."],
  ["attraction", "Draw an enemy piece onto a fatal square."],
  ["hangingPiece", "Something is left undefended."],
  ["trappedPiece", "An enemy piece has nowhere safe to go."],
  ["promotion", "Think about promoting a pawn."],
  ["advancedPawn", "Your advanced pawn is the key."],
  ["sacrifice", "Giving up material may be the strongest idea."],
  ["quietMove", "The best move is not a check or a capture."],
  ["defensiveMove", "First take care of the threat against you."],
  ["zugzwang", "Make a move that leaves your opponent only bad options."],
  ["xRayAttack", "Look through a piece to the target behind it."],
  ["intermezzo", "Insert an in-between move before the obvious recapture."],
  ["capturingDefender", "Remove the piece that guards the key square."],
];

export function playUci(pos, uci) {
  const move = legalMove(pos, uci);
  if (!move) throw new Error(`Illegal move ${uci}`);
  pos.play(move);
}

function themeHint(themes) {
  for (const [theme, text] of THEME_HINTS) if (themes.includes(theme)) return text;
  return "Look for checks, captures and threats.";
}

function normalized(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseTsv(text, columns) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== columns) throw new Error(`Malformed bank row: ${line.slice(0, 60)}`);
    rows.push(fields);
  }
  return rows;
}

/** A board question for an opening line: the position before its last move, answered by that move. */
export function openingPuzzle(name, moves) {
  const pos = Chess.default();
  for (const uci of moves.slice(0, -1)) playUci(pos, uci);
  return puzzlePayload(makeFen(pos.toSetup()), moves.slice(-1), [], `Recall the ${name} move order: what is the next move?`);
}

/** Turns one bank row into a chess_training_question payload: one authored line and per-move progressive hints. */
export function puzzlePayload(fen, moves, themes, firstHint = themeHint(themes)) {
  const pos = startPosition(fen);
  const hints = [];
  moves.forEach((uci, ply) => {
    if (ply % 2 === 0) {
      const from = uci.slice(0, 2);
      const role = pos.board.get(parseSquare(from))?.role;
      const piece = PIECE_NAMES[role] ?? "piece";
      hints.push([
        ply === 0 ? firstHint : "Keep going: find the most forcing continuation.",
        `Use your ${piece}.`,
        `Move the ${piece} on ${from}.`,
      ]);
    }
    playUci(pos, uci);
  });
  return { fen, lines: [moves], hints };
}

function pick(items, count, random) {
  const pool = items.slice();
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return out;
}

export function createBank(directory, { random = Math.random } = {}) {
  let puzzles;
  let openings;
  const load = async (file, columns) => parseTsv(await readFile(path.join(directory, file), "utf8"), columns);

  return {
    async findPuzzles(input = {}) {
      puzzles ??= (await load(PUZZLES, 6)).map(([id, fen, moves, rating, themes, openings]) => ({
        id, fen, moves: moves.split(" "), rating: Number(rating), themes: themes.split(" "), openingTags: openings ? openings.split(" ") : [],
      }));
      const wanted = input.themes ?? [];
      const opening = input.opening ? normalized(input.opening) : "";
      const excluded = new Set(input.exclude ?? []);
      const min = input.ratingMin ?? 0, max = input.ratingMax ?? 4000;
      const matches = puzzles.filter(p => p.rating >= min && p.rating <= max && !excluded.has(p.id)
        && wanted.every(theme => p.themes.includes(theme))
        && (!opening || p.openingTags.some(tag => normalized(tag).includes(opening))));
      const chosen = pick(matches, input.count ?? 1, random).map(p => ({
        id: p.id, rating: p.rating, themes: p.themes, openingTags: p.openingTags,
        url: `https://lichess.org/training/${p.id}`,
        payload: puzzlePayload(p.fen, p.moves, p.themes),
      }));
      return { source: "Lichess puzzle database (CC0)", matched: matches.length, puzzles: chosen };
    },

    async findOpenings(input) {
      openings ??= (await load(OPENINGS, 3)).map(([eco, name, moves]) => ({ eco, name, moves: moves.split(" ") }));
      const query = input.query.trim();
      const eco = /^[A-E]\d{0,2}$/i.test(query) ? query.toUpperCase() : "";
      const words = normalized(query).split(" ");
      const matches = openings.filter(o => eco ? o.eco.startsWith(eco) : words.every(word => normalized(o.name).includes(word)));
      // Shortest lines first: the main line of a family precedes its sub-variations.
      matches.sort((a, b) => a.moves.length - b.moves.length || a.name.localeCompare(b.name));
      const openingsFound = matches.slice(0, input.limit ?? 5).map(o => ({ ...o, nextMovePuzzle: openingPuzzle(o.name, o.moves) }));
      return { source: "lichess-org/chess-openings (CC0)", matched: matches.length, openings: openingsFound };
    },
  };
}
