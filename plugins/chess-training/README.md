# chess-training

External trusted-local LearnHarness API v1 plugin. **Not installed or enabled by this project.** Requires the unreleased native-question API on `feature/plugin-architecture` (tested against worktree checkpoint `99373a142aaa84dde97a94f1a63a1263224425f2`), not merely any released app matching the manifest's numeric minimum.

Memory-only interactive lessons, independent durable native puzzles and optional bounded backend engine evidence, standard chess only: Chessground 10.5.0 + chessops 0.15.1 + pinned Stockfish.js 19.0.1 lite-single. No database, account integration, generic tool builder, model calls, custom views or host production changes.

## Build / review / install later

From this directory:

```sh
fnm exec --using=26 npm ci --ignore-scripts
fnm exec --using=26 npm run build
fnm exec --using=26 npm test
fnm exec --using=26 npm run test:public
fnm exec --using=26 npm run test:browser
fnm exec --using=26 npm run test:engine # separate bounded REAL engine smoke
```

Build output: `dist/chess-training/`, containing root manifest, bundled browser ESM, backend CommonJS, scoped CSS with embedded piece artwork, licenses, and corresponding source. Runtime needs no npm install and no checkout imports. The separate `test:public` suite requires the matching host checkout, read-only. `test:browser` additionally uses that checkout's puppeteer-core and system Chrome; it starts only its own ephemeral loopback public-plugin harness with a disposable browser profile/data, not the native host or a model provider. The ordinary `npm test` suite uses only this package and disposable temporary storage. Build refuses an output directory containing `data/` or a symlinked output directory.

**Do not install before deliberate read-only review.** After approval, copy **contents of `dist/chess-training/`**, not this source project, to the explicit plugin directory's `chess-training/`. Preserve any existing `data/`, refresh discovery, then deliberately enable/restart through the host. This implementation does not change the existing preview profile or running servers. Do not copy sample puzzles into real learning history.

## Puzzle bank and opening reference (teacher AND prober)

Two read-only tools let the agent use real material instead of recalling positions from memory:

- `chess_training_find_puzzles` picks 1–5 puzzles from `bank/puzzles.tsv` by Lichess theme keys (all must match), an opening name fragment matched against the puzzle's opening tags, and a rating range. `exclude` skips ids already used in the conversation. Each result has a ready `payload` for `chess_training_question` / `chess_training_probe`: the FEN before the learner's first move, the Lichess solution as one authored line, and three progressive English hints per learner move (the theme idea, the piece, its square). Other legal moves, including alternative mates, roll back neutrally. The model receives the payloads; the learner-facing card shows only how many puzzles matched and their ratings.
- `chess_training_find_openings` searches `bank/openings.tsv` by name fragment or ECO prefix and returns the line as legal UCI moves from the standard starting position (castling as the king's destination), shortest lines first, for building lessons.

`scripts/build-bank.mjs <lichess_db_puzzle.csv> <chess-openings dir>` rebuilds both files. Puzzle selection keeps well-tested puzzles only (rating deviation ≤ 80, popularity ≥ 85, at least 1,000 plays), samples up to 1,500 per 200-point rating band, and adds up to 40 more per opening family so every family has material; every kept puzzle and every opening line is replayed through the plugin's own legality check. The bundled build (from the 2026-11-01 export) holds 18,897 puzzles across ratings 400–2800 and 151 opening families, and 3,865 opening lines.

## Optional engine evidence (teacher AND prober)

`chess_training_analyze` accepts `{ "fen": "<full six-field standard FEN>", "candidates": ["e2e4"] }`; candidates are optional, otherwise 1–8 distinct legal standard UCI moves from that FEN. Invalid inputs are refused before worker creation. It does not change any puzzle/lesson schema or controller/store format. No analysis runs automatically at activation, pose, board navigation or manual submission.

One lazy `worker_threads.Worker` per request, no idle worker. One active request per activation; concurrent calls receive a clear busy error, no queue. Runtime resolves from public `ctx.directory`, never cwd/checkout imports. Exact pinned JS+WASM, embedded NNUE and complete corresponding source/build scripts/licenses ship offline in backend-only `engine/`, outside frontend/assets; see `engine/README.md`. No startup/use downloads or installation-time npm.

**LIGHT workload policy:** one thread, Hash16 MiB, at most 200 ms per search, at most 3 seconds total including initialization/handshake. Baseline unrestricted search followed by sequential single-candidate `searchmoves` searches as remaining budget permits; MultiPV=1 is not complete alternative coverage. Normal `movetime` is 175 ms, parent stop at 180 ms and parent hard search cutoff at 200 ms; shortened adaptively near the request deadline. The parent request cutoff starts termination at 2800 ms, reserving 200 ms for awaited cleanup. These are cooperative OS/runtime timer deadlines, not hard-real-time guarantees under an externally suspended/starved process. Cancellation/disable stops work and awaits termination; late events cannot publish new evidence. No model-worker misuse, background queue, cache or persisted engine results.

Result `kind: "engine-evidence"` contains `completed`, `partial`, `reason`, exact engine build/hashes/options/budgets, root `scorePerspective`, ordered `searches`, unsearched candidates and elapsed time. Each search includes candidate (null means unrestricted), requested time, completion/reason, bestmove, and the latest scored info (`score`, depth/nodes/time, PV). Missing values remain null, not fabricated. **All scores are from the supplied FEN side to move**, even candidate-restricted searches: cp and signed mate-in-moves remain different units, with exact/lowerbound/upperbound flags preserved. “Exact” is UCI's search-bound flag, not proven chess truth; “completed” means the requested bounded searches returned evidence, not correctness. FEN lacks repetition history. Partial, no-progress, cancellation and errors do not imply a bad move. Missing alternatives cannot prove uniqueness. There is no `verified:true`, authoritative grade, mandatory receipt/admission or whole-game analyzer.

Legality from chessops, membership in authored exercise lines and engine-supported finite evidence are **different claims**. Teacher/prober instructions require the actual analyzer for strength/alternative claims, not fabricated evaluations. Existing authored puzzles are **not all engine-checked**. Lessons intentionally may show bad legal moves; no strongest-move gate. Host ordinary teacher/prober review remains unchanged.

**RAM/CPU:** WASM initial linear memory is 128 MiB (growth enabled, maximum 2 GiB); Hash16 is **not total RSS**. Prior isolated short probes sampled roughly 150 MiB whole-process RSS (not exact incremental production cost). Worker resourceLimits do not cap WASM/external buffers and are not used as a RAM guarantee. Single-thread searches can fully occupy one core while active. Lite-network/finite-budget evidence is not a strength, teaching-quality or uniqueness guarantee.

`test:engine` copies the built package outside the checkout, uses an empty disposable profile, exercises synthetic white/black mates, a hanging queen, explicit candidate searches, busy refusal, real cancellation, disable cleanup and parent deadline termination of deliberately non-yielding fake threads (only disposable worker copies are replaced) without a Next server, models or user profiles. It is **not engine-strength validation**. Run that same script with installed Electron as Node (`ELECTRON_RUN_AS_NODE=1 <electron-binary> scripts/engine-smoke.mjs`), not the desktop application. Cross-platform packaged integration, signed installation and actual production incremental RAM remain unverified. Installation is not performed.

## Interactive lesson contract v1

The teacher-only native tool `chess_training_lesson` presents public teaching material in its tool-result card. It is not a question, assessment, executable code block or answer editor. Its arguments are **exactly the lesson object**, without a `payload`, `question`, `type` or `nodeId` wrapper:

```json
{
  "version": 1,
  "title": "Explore central development",
  "explanation": "Compare two legal openings, then explore freely. These lines are illustrative, not engine evaluations.",
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "orientation": "white",
  "annotations": {
    "explanation": "The central squares are useful reference points.",
    "arrows": [{"from": "e2", "to": "e4", "color": "green"}],
    "circles": [{"square": "d4", "color": "blue"}],
    "highlights": [{"square": "e4", "color": "yellow"}]
  },
  "variations": [
    {
      "name": "Open game",
      "moves": ["e2e4", "e7e5", "g1f3"],
      "annotations": [
        {"ply": 0, "explanation": "Start with the king pawn."},
        {
          "ply": 3,
          "explanation": "The knight now influences the centre.",
          "arrows": [{"from": "f3", "to": "e5", "color": "red"}]
        }
      ]
    },
    {"name": "Queen pawn", "moves": ["d2d4", "d7d5"]}
  ]
}
```

Required fields are `version` (exactly `1`), nonblank `title` and `explanation`, one full six-field standard-chess `fen`, explicit `orientation` (`white` or `black`, independent of side to move), and `variations` (an array, possibly empty). Each variation requires a unique nonblank `name` and a `moves` array of legal standard UCI strings from that **same starting FEN**. All moves of **every** variation are validated before presentation. Empty, odd and even move counts are allowed: lessons have no learner/opponent parity restriction. Castling uses king destination (`e1g1`, not `e1h1`); promotions and underpromotions require `q/r/b/n`. Invalid author data returns readable repair errors. Text is preserved verbatim. Unknown fields are rejected at every object level.

Optional root `annotations` has any of `explanation` (nonblank text), `arrows` (`{from,to,color}`), `circles` and `highlights` (both `{square,color}`), with the latter three arrays. Squares are `a1`–`h8`; colors are exactly `green`, `red`, `blue` or `yellow`. Optional variation `annotations` is an array of those same objects plus required integer `ply`: `0` is the starting position, `1` is after one move, up to the variation's full move count. Each ply may appear only once per variation. An annotation at the current variation ply **replaces**, rather than merges with, root annotations. Root annotations apply only at ply zero when no variation-specific annotation is present. Other positions without authored annotations have no markings. Colors/markings also have readable text descriptions.

Select a named variation and use **Previous ply / Next ply**, or play legal moves for either side by board click/drag or UCI entry. No automatic reply occurs. Selecting a variation replaces the explored path and starts at ply zero; playing any free move leaves the authored variation, even if it matches its continuation, and clears its annotations. **Undo** removes one ply; **Reset** restores the original position and root annotations. Board promotions require an explicit piece choice, including underpromotion.

Exploration is **memory-only**, scoped to that mounted lesson card. Navigation, free moves and selected variation are not saved, submitted, graded or sent to the agent. Remount/reload reconstructs the authored lesson, not the explored position. The ordinary native tool arguments/result remain authored conversation content; that is distinct from persisting local exploration. The agent sees public authored material and normal conversation content only, not which variation/ply the learner selected or explored, and must not treat unobserved actions as learning evidence.

For a follow-up assessment the teacher must pose a **fresh independent puzzle** with `chess_training_question`, supplying its own full FEN, lines and hints. Lesson and puzzle boards never synchronize. The existing puzzle contract, backend durability, explicit hints and manual host submission remain unchanged; the memory-only lesson adds no writes to puzzle records or host/profile state.

## Native probe / teaching contract v1

Backend registers `id: "puzzle"`, `contractVersion: 1`, `showThinking: true`, with native tool `chess_training_probe` for **prober** and `chess_training_question` for **teacher**. Frontend registers the owner-scoped native answer editor and answered presentation. The common `question` supplies the learner-facing Markdown condition and safe native fallback; no generic tool renderer dumps the private payload.

Teacher tool arguments (unchanged):

```json
{
  "type": "predict",
  "nodeId": "an-applicable-live-plan-node",
  "question": "Play the central pawn, then develop your kingside knight.",
  "payload": {
    "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "lines": [["e2e4", "e7e5", "g1f3"]],
    "hints": [
      ["Start in the centre.", "Advance the king pawn two squares."],
      ["Develop a minor piece.", "Move the kingside knight toward the centre."]
    ]
  }
}
```

For `chess_training_probe`, supply only `question` and `payload` from the example above: **no `type` or `nodeId`**. Probe has no check reading/reveal flow; the same interactive editor opens directly with optional host Thinking. Role-targeted instructions tell the prober to use actual interactive puzzles for move-based chess diagnosis, not screenshots/text-only questions, and not to ask the learner to install or locate this available plugin. They do not skip diagnosis, fabricate assessment or force `probe_done`.

This is a **synthetic interaction fixture**, not a tactically unique engine-checked puzzle. The teacher or prober authors the condition, full FEN **immediately before the learner's FIRST move**, complete legal UCI lines, and ordered progressively specific hints. Teacher `check` retains the host's normal reading/reveal flow. Practice is not enrolled. No agent-supplied code is executed.

- Full six-field standard FEN; side to move is the learner and board orientation.
- `lines`: one or more complete alternating learner/opponent UCI arrays. Each ends on a learner move (odd length). Promotions need `q/r/b/n`; castling uses king destination (`e1g1`, not `e1h1`). All complete lines are validated for legality **before pose**; bad author data returns readable tool repair errors.
- After an accepted learner move, the first compatible authored line in input order supplies the automatic opponent reply. Any completed authored line finishes the puzzle, including a terminal line that prefixes a longer one.
- Legal but unauthored moves receive neutral feedback: the move is not included in the authored puzzle lines and its chess quality has not been established. Illegal UCI entries still receive illegal-move feedback. Both roll back and are recorded as retries without consuming the turn. Acceptance means agreement with the authored continuations, not engine correctness/completeness.
- `hints`: shared array per learner-move ordinal, with one nonempty progressive hint array per move up to the longest line. Shared hints must make sense for all compatible variations. **Only explicit `?` requests reveal hints**, one at a time for the current move; previously revealed hints remain visible. Exhausted hint button disables.
- Drag/click or enter UCI and press Play move/Enter. Board promotions require an explicit Queen/Rook/Bishop/Knight choice; there is no silently assumed queen. Escape cancels only a pending promotion. Host modifiers/IME remain host-owned. UCI entry also supplies a keyboard path; this is not a full screen-reader board-navigation implementation.

Answer JSON (the host constructs identity, time and thinking separately):

```json
{
  "moves": ["e2e4", "e7e5", "g1f3"],
  "incorrectAttempts": [{"atPly": 0, "move": "d2d4"}],
  "revealedHints": [{"learnerMove": 0, "count": 1}]
}
```

`moves` includes learner moves and automatic replies. `atPly` and `learnerMove` are **zero-based**; hint counts denote the revealed prefix of the corresponding authored hint array. Thus the ordinary teacher or prober receives final moves, all recorded retries, and exact used hints in the original authored context. The persisted `incorrectAttempts` field and its format remain unchanged: it mixes illegal entries and legal moves outside authored lines, not established chess errors. Neither its name nor its count establishes move quality or learner misunderstanding; teacher/prober review must distinguish legality from authored-line membership and independently justify any chess-quality assessment. The editor and answered slot label these records **Recorded retries**. The answered slot displays the used hint text and attempts, not unrevealed hints or unplayed solutions.

Only a durably acknowledged complete puzzle publishes `ready`. Completion **does not submit**: the learner intentionally uses the normal host **Submit** button. Optional explanation goes into the host **Your thinking** field. The host returns the ordinary native answer envelope to the teacher or prober for review. The plugin has **no `validateAnswer` grading hook**: its native answer schema validates format only, and well-formed incorrect answers remain acceptable at that boundary. Controller/storage coherence checks are separate from submission-format validation.

## Answered puzzle replay

Answered puzzles include a **Show board** button. The read-only board opens at the final saved position; **Previous move** and **Next move** step through the submitted moves, including opponent replies. It never reveals unplayed solution branches or unused hints, accepts no free moves, and does not read or modify progress. Hiding or disposing the replay releases its board; reopening starts at the final position. An unplayable historical move sequence gets a readable fallback rather than a fabricated replay.

## Durability and lifecycle

`ctx.dataDirectory/puzzles/<SHA-256 identity>.json` is plugin-owned private backend storage, never `assets/`, source or public files. Identity combines `chatId`, the host-minted `questionId` (already bound by the host to the exact canonical occurrence), and contract version. The editor API does not expose a second occurrence tuple; no DOM or tool-call-ID inference is used. Records bind exact authored payload and refuse corruption, payload mismatch, unknown versions or malformed progress.

`open-puzzle` restores or atomically creates initial state and grants a fresh mount lease. `act-puzzle` accepts only move/hint commands with expected revision and current lease; it recomputes the transition on the backend, validates, writes a mode-0600 temporary file, fsyncs, renames, fsyncs the record-owning directory and its two owning ancestors (including the host-created data-directory entry), then acknowledges. Reopening an existing record also resyncs these owners before granting a lease, so uncertain post-rename writes cannot be acknowledged merely from page cache. Updates and mounts are serialized. Older mounts/revisions cannot overwrite newer state. Incoming host memory drafts never cause backend writes; `update` never echoes `onChange`. Abort/dispose fences late publications, destroys Chessground and removes listeners. Nothing is written on unmount.

Every acknowledged move, retry and hint survives editor remount, full reload and backend restart. In-flight/failed writes are not claimed durable; a post-rename failure can leave a committed record, so the UI blocks further actions and offers **Reload saved progress** to reconcile rather than replaying automatically. With multiple windows, the newest opened editor lease owns editing; an older window must explicitly reload before editing. Serialization is for the single host backend activation/process, not an unsupported shared-data multiprocess deployment. POSIX atomic/fsync behavior is tested; Windows directory fsync is not verified.

Puzzle state is retained after submission/dismissal/disable; there is no automatic cleanup/deletion policy. Host Thinking/ReadingThinking drafts remain host-owned and **are not made durable by this plugin**. Native host memory drafts are not advertised as restart persistence.

## Privacy / limitations

Unplayed solutions and unrevealed hints stay out of learner-facing DOM and generic traces. This is **not a security boundary**: trusted browser code/users can inspect authored payloads. No strategic verification or security claim is made. GPL runtime licenses and the Cburnett artwork attribution are in `THIRD-PARTY-NOTICES.md` and `licenses/`.

Verification covers pure lesson FEN/UCI, all-variation legality, odd/even lengths, castling, en passant, promotion/underpromotion, free play, undo/reset, variation replacement, annotation/stale-branch behavior, immutability and schema/refinement validation; pure puzzle controller/contract/storage, jsdom editor lifecycle, real Chessground jsdom initialization/destruction, built package registration against public host contracts, native probe/teach parameter schemas and isolated synthetic pose/answer round-trips (including host Thinking), and a real Chrome public-plugin harness: probe click moves, rollback/retry, explicit hints, reload/backend-restart recovery, manual-only completion, and teacher explicit Knight underpromotion; lesson click/drag/UCI exploration for both sides, visible arrows/circles/highlights and their clearing, variation navigation, one-ply undo, reset, explicit promotion/underpromotion, independent simultaneous lesson cards, reload resetting local exploration, abort/repeated cleanup, and zero lesson backend calls or submissions. It does **not** establish an installed preview session, a complete real-browser native pose/reload/submit/teacher-or-prober-review flow, OS input/microphone, Electron window, Windows/Linux durability, strategic teaching quality or release readiness. No real credentials, paid models or learner profiles are needed by these tests.
