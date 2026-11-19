import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createBank, puzzlePayload } from '../src/bank.js';
import { validatePuzzle } from '../src/core.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every bundled puzzle becomes a valid native puzzle payload', async () => {
  const rows = (await readFile(path.join(root, 'bank/puzzles.tsv'), 'utf8')).trim().split('\n');
  assert.ok(rows.length > 10000);
  for (const row of rows) {
    const [, fen, moves, , themes] = row.split('\t');
    const payload = puzzlePayload(fen, moves.split(' '), themes.split(' '));
    validatePuzzle(payload);
    assert.equal(payload.hints.length, (payload.lines[0].length + 1) / 2);
  }
});

test('hints go from the theme idea to the piece to its square', () => {
  // Scholar's-mate pattern: white to move, Qh5xf7 is mate.
  const payload = puzzlePayload('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', ['h5f7'], ['mateIn1', 'opening']);
  assert.deepEqual(payload.hints, [['There is a checkmate in one move.', 'Use your queen.', 'Move the queen on h5.']]);
});

test('puzzle search filters by theme, rating, opening and exclusions', async () => {
  const bank = createBank(root);
  const forks = await bank.findPuzzles({ themes: ['fork'], ratingMin: 1200, ratingMax: 1400, count: 5 });
  assert.equal(forks.puzzles.length, 5);
  assert.equal(new Set(forks.puzzles.map(p => p.id)).size, 5);
  for (const p of forks.puzzles) {
    assert.ok(p.themes.includes('fork') && p.rating >= 1200 && p.rating <= 1400);
    validatePuzzle(p.payload);
  }
  const sicilian = await bank.findPuzzles({ opening: 'sicilian', count: 5 });
  assert.ok(sicilian.puzzles.every(p => p.openingTags.some(tag => tag.startsWith('Sicilian'))));
  const all = await bank.findPuzzles({ themes: ['fork'], ratingMin: 1200, ratingMax: 1400 });
  const rest = await bank.findPuzzles({ themes: ['fork'], ratingMin: 1200, ratingMax: 1400, exclude: forks.puzzles.map(p => p.id) });
  assert.equal(rest.matched, all.matched - 5);
  assert.equal((await bank.findPuzzles({ themes: ['noSuchTheme'] })).puzzles.length, 0);
});

test('opening lookup by name and ECO returns legal lines, main line first', async () => {
  const bank = createBank(root);
  const caro = await bank.findOpenings({ query: 'Caro-Kann' });
  assert.equal(caro.openings[0].name, 'Caro-Kann Defense');
  assert.deepEqual(caro.openings[0].moves.slice(0, 2), ['e2e4', 'c7c6']);
  const eco = await bank.findOpenings({ query: 'c60', limit: 10 });
  assert.ok(eco.openings.length > 0 && eco.openings.every(o => o.eco === 'C60'));
  const castled = (await bank.findOpenings({ query: 'Ruy Lopez Closed', limit: 10 })).openings.find(o => o.moves.includes('e1g1'));
  assert.ok(castled, 'castling uses the king destination');
});
