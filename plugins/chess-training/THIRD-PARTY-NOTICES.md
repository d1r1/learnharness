# Runtime licensing

Plugin source: GPL-3.0-or-later (see LICENSE).

- Chessground **@lichess-org/chessground 10.5.0**, Lichess contributors: GPL-3.0-or-later. https://github.com/lichess-org/chessground . License: `licenses/chessground-GPL-3.0.txt`. Browser board and base CSS are bundled; CSS selectors are scoped under `.chess-training`.
- chessops **0.15.1**, Niklas Fiekas and contributors: GPL-3.0-or-later. https://github.com/niklasf/chessops . License: `licenses/chessops-GPL-3.0.txt`.
- @badrap/result **0.3.1**, Badrap and contributors: MIT. https://github.com/badrap/result . License: `licenses/badrap-result-MIT.txt`.
- **Cburnett chess pieces**, Colin M. L. Burnett (User:Cburnett): selected GPL-3.0-or-later licensing option. SVG artwork embedded in Chessground's `assets/chessground.cburnett.css`, unchanged except selector scoping. Original artist: https://commons.wikimedia.org/wiki/User:Cburnett . All twelve source file pages were checked on 2026-11-04; each explicitly permits GPL version 3 or later:
  - https://commons.wikimedia.org/wiki/File:Chess_plt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_pdt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_nlt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_ndt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_blt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_bdt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_rlt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_rdt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_qlt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_qdt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_klt45.svg
  - https://commons.wikimedia.org/wiki/File:Chess_kdt45.svg

- **Stockfish.js 19.0.1 lite-single**, Nathan Rugg, Chess.com and Stockfish developers: GPL-3.0-or-later engine code, original MIT notices for non-engine upstream code retained in source. Unmodified official JS+WASM, backend-only in `engine/`. GPL text: `licenses/stockfish-GPL-3.0.txt`; authors: `engine/AUTHORS`. Exact complete corresponding source/build scripts at commit `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6` accompany every built package in `engine/source/stockfish.js-0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6.tar.gz`.
- Embedded lite NNUE **nn-61e7af4bb97d**, credited by upstream to **sscg13**: CC0-1.0; license `licenses/stockfish-network-CC0.txt`, exact network build input in `engine/source/`. Pinned official upload/license evidence, hashes, primary URLs and build instructions: `engine/README.md`. No floating master-only source offer, runtime downloads or other engine flavors.

The checkerboard is a CSS gradient, not a borrowed board image. No fonts or external network artwork are loaded. Stockfish runtime and embedded net load only from the local backend package. Build-time esbuild (MIT) and test-only jsdom (MIT) are not bundled into runtime code.

Built packages include plugin corresponding source/build inputs under `source/` and the exact runtime library packages under `source/vendor/`, including their source and license files. Distribute these alongside bundles and notices; preserve GPL notices and offer corresponding source when distributing or deploying. This records selected licenses, not legal advice or a release authorization.

Bundled data: `bank/puzzles.tsv` is derived from the Lichess puzzle database (https://database.lichess.org/#puzzles) and `bank/openings.tsv` from lichess-org/chess-openings (https://github.com/lichess-org/chess-openings); both are released under CC0-1.0 (public domain dedication).
