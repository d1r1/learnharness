# Exact offline Stockfish distribution

Stockfish.js 19.0.1 **lite-single** only, unmodified release artifacts.
Engine: Nathan Rugg, Chess.com and Stockfish developers (see AUTHORS and source notices).
License: GPL-3.0-or-later for engine code (upstream files); GPLv3 text accompanies this package at `../licenses/stockfish-GPL-3.0.txt`. Upstream non-engine code retains its MIT notices in the archive. No npm package/all-flavor distribution is included.

Pinned source commit: `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`.
Release: https://github.com/nmrugg/stockfish.js/releases/tag/v19.0.1

| File | SHA-256 |
| --- | --- |
| stockfish-19-lite-single.js | ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a |
| stockfish-19-lite-single.wasm | ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de |
| source/stockfish.js-0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6.tar.gz | e5289a920554bf0069a6601c228e81d957c00522bb31c4343588dc5d7d251879 |
| source/nn-61e7af4bb97d.nnue | 61e7af4bb97d51eeeb25d322916f86513b5cd3a827ce189c98c6e31946f99e5b |

Complete corresponding engine sources, build scripts and original notices are delivered **offline in the accompanying source archive**, not merely offered at a floating source URL. The exact lite NNUE input is also delivered, separately because the upstream git archive does not include it. Its attribution in pinned `README.md` and `src/emscripten/credits-lite.js` credits **sscg13** and https://tests.stockfishchess.org/nns?network_name=nn-61e7af4bb97d . Preserve these notices when redistributing engine and network. The NNUE network is **CC0-1.0**, not an independently authored plugin asset. The official Fishtest upload policy requires authorship or an existing CC0 license and licenses uploads under CC0; an offline copy is included at `source/fishtest-network-upload-policy.html.j2`, pinned primary source https://github.com/official-stockfish/fishtest/blob/5a8a229a521b4eaab2ecf19b92f0d2fd6c3be13b/server/fishtest/templates/nn_upload.html.j2 . The full CC0 text accompanies this package at `../licenses/stockfish-network-CC0.txt` (from https://github.com/official-stockfish/networks/blob/c70ccc66fa3eff72c4d7afe0b1cd731230588d0e/LICENSE). Engine embedding retains the GPL engine obligations.

Primary retrieval endpoints (verified HTTPS; runtime never uses them):
- https://github.com/nmrugg/stockfish.js/releases/download/v19.0.1/stockfish-19-lite-single.js
- https://github.com/nmrugg/stockfish.js/releases/download/v19.0.1/stockfish-19-lite-single.wasm
- https://codeload.github.com/nmrugg/stockfish.js/tar.gz/0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6
- https://tests.stockfishchess.org/api/nn/nn-61e7af4bb97d.nnue

## Building corresponding sources

Unpack the archive, copy the accompanying `.nnue` file into its `src/` directory. Upstream requires Emscripten **6.0.9**, Node and make (standard toolchain prerequisites, not runtime dependencies). Follow the included pinned README and `build.js --help`; the single-lite flavor command is:

```
node build.js --lite --single-threaded --no-split --strict-em-check
```

`build.js`, `src/Makefile`, `src/emscripten/wasm-makefile.mk` and all glue/C++ sources are included. The upstream default build strips Syzygy; the lite net is embedded in WASM. We ship the official binary, not a local rebuild; byte-reproducible rebuilding was not tested. No engine modifications were made. Plugin wrapper/build/test sources accompany the plugin separately at `source/` in the built package.

## Pinned UCI evidence used by the wrapper

All following paths are in the accompanying exact source archive (primary source; no assumption from a different Stockfish version):
- `src/uci.cpp`, `parse_limits`: `searchmoves` is last and consumes the remaining tokens. `go movetime N searchmoves MOVE` restricts root moves, not the position after MOVE.
- `src/thread.cpp`, `ThreadPool::start_thinking`: legal root move filtering by searchmoves; `src/search.cpp` root negamax and `SearchManager::output_pv`: output is from root side to move, including restricted searches. The wrapper keeps that perspective; it does not negate black scores.
- `src/uci.cpp`, `on_update_full`, `format_score`; `src/score.cpp`: cp and mate are distinct output variants. Mate is signed full moves, not centipawns. `lowerbound`/`upperbound` are preserved. `SearchManager::output_pv` can omit MultiPV entries/return previous iteration scores; omission cannot establish uniqueness. The wrapper uses MultiPV=1 plus explicit separate candidate searches, not complete alternative coverage.
- `src/uci.cpp`, `process_cmd`: UCI handshake/readiness, stop and bestmove. `src/emscripten/extern-post.js` is the release wrapper used through the tested Node worker forwarding pattern.
- `src/emscripten/wasm-makefile.mk`: single thread, SIMD/Asyncify, initial linear memory 128 MiB, max 2 GiB with growth. Hash16 is not a total RAM/RSS cap; Node Worker resourceLimits are not used as one.

There is no engine-strength validation here. Finite searches and synthetic smoke positions provide bounded evidence only. Runtime files and these sources are backend-only, outside public assets.
