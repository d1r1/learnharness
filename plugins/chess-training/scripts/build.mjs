import { build } from 'esbuild';
import { mkdir, copyFile, cp, lstat, rm, access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const out = path.join(dist, 'chess-training');
for (const directory of [dist, out]) {
  try { if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Refusing linked output: ${directory}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
try { await access(path.join(out, 'data')); throw new Error('Refusing to build over plugin data; preserve it separately.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [entry, file, platform, format] of [['main.js', 'main.js', 'browser', 'esm'], ['backend.js', 'backend.cjs', 'node', 'cjs']]) {
  const result = await build({ entryPoints: [path.join(root, 'src', entry)], outfile: path.join(out, file), bundle: true, platform, format, target: 'es2022', metafile: true, legalComments: 'linked' });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!path.resolve(input).startsWith(root + path.sep)) throw new Error(`Unexpected external source in bundle: ${input}`);
  }
}
// These upstream files contain only flat selector rules (no keyframes or at-rules).
// Scope every selector, including bare custom-element selectors, not just .cg-wrap.
let styles = '';
for (const file of ['chessground.base.css', 'chessground.cburnett.css']) {
  const css = (await readFile(path.join(root, 'node_modules/@lichess-org/chessground/assets', file), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  if (css.includes('@') || /[{}][^{}]*\{[^{}]*\{/.test(css)) throw new Error('Review CSS scoping for changed upstream structure.');
  styles += css.replace(/([^{}]+)\{/g, (_, selectors) => selectors.split(',').map(selector => `.chess-training ${selector.trim()}`).join(',\n') + ' {');
}
styles += '\n' + await readFile(path.join(root, 'src/styles.css'), 'utf8');
await writeFile(path.join(out, 'styles.css'), styles);
for (const file of ['manifest.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md']) await copyFile(path.join(root, file), path.join(out, file));
await cp(path.join(root, 'licenses'), path.join(out, 'licenses'), { recursive: true });
// Backend-only files: the host serves neither this directory nor this worker entry.
await cp(path.join(root, 'engine'), path.join(out, 'engine'), { recursive: true });
await cp(path.join(root, 'bank'), path.join(out, 'bank'), { recursive: true });
await copyFile(path.join(root, 'src/engine-worker.cjs'), path.join(out, 'engine-worker.cjs'));
for (const directory of ['src', 'scripts', 'tests']) await cp(path.join(root, directory), path.join(out, 'source', directory), { recursive: true });
for (const file of ['package.json', 'package-lock.json']) await copyFile(path.join(root, file), path.join(out, 'source', file));
for (const name of ['@lichess-org/chessground', 'chessops', '@badrap/result']) {
  await cp(path.join(root, 'node_modules', name), path.join(out, 'source/vendor', name), { recursive: true });
}
console.log(`Built external package: ${out}`);
