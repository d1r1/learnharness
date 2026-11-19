import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  preparePluginQuestionType, createPluginQuestionParameters, validatePluginQuestionInput,
  validatePluginQuestionAnswer, readPluginQuestionAnswer, readPluginQuestionSnapshot,
} from '../../../src/core/plugin-questions.ts';
import { parsePluginManifest } from '../../../src/core/plugins.ts';
import { projectView } from '../../../src/core/view.ts';
import { toLlmMessages } from '../../../src/core/native-messages.ts';
import { Compile } from 'typebox/compile';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const hostRoot = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const run = promisify(execFile);
const puzzle = () => ({
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  lines: [['e2e4', 'e7e5', 'g1f3']],
  hints: [['Occupy the center', 'Play e4'], ['Develop a knight']],
});
const input = () => ({ question: 'Find the best continuation.', type: 'predict', nodeId: 'node', payload: puzzle() });

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `Package must not escape through a symlink: ${name}`);
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), name));
    else result.push(name);
  }
  return result.sort();
}

async function fixture(t) {
  // External install: no package.json ancestry or node_modules from the checkout.
  const root = await mkdtemp(join(tmpdir(), 'chess-public-registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'chess-training');
  await cp(join(pluginRoot, 'dist/chess-training'), directory, { recursive: true });
  const dataDirectory = join(root, 'data');
  await mkdir(dataDirectory);
  const packageFiles = await files(directory);
  assert.equal(packageFiles.some(name => name.split(/[\\/]/).includes('node_modules')), false);
  assert.equal(resolve(directory).startsWith(resolve(hostRoot) + '/'), false);
  const raw = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const manifest = parsePluginManifest(raw, 'chess-training', '0.4.1');
  assert.deepEqual(manifest, raw);
  for (const name of [manifest.main, manifest.backend, manifest.styles]) {
    assert.equal((await lstat(join(directory, name))).isFile(), true);
  }
  return { root, directory, dataDirectory, manifest, packageFiles };
}

function activateBackend(t, f) {
  const questions = [], instructions = [], tools = [], handlers = new Map();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const dispose = require(join(f.directory, f.manifest.backend)).activate({
    directory: f.directory,
    dataDirectory: f.dataDirectory,
    signal: controller.signal,
    handle(name, handler) {
      assert.equal(handlers.has(name), false);
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerQuestionType(definition) { questions.push(definition); return () => {}; },
    registerInstructions(value) { instructions.push(value); return () => {}; },
    registerTools(value) { tools.push(value); return () => {}; },
    // Deliberately no model, profile, or host-internal service APIs.
  });
  t.after(() => dispose());
  assert.equal(questions.length, 1);
  return { definition: preparePluginQuestionType(questions[0]), instructions, tools, handlers };
}

test('external built backend registers public probe and teach contracts and validates native parameters', async t => {
  const f = await fixture(t);
  const { definition, instructions, handlers } = activateBackend(t, f);
  assert.equal(definition.id, 'puzzle');
  assert.equal(definition.contractVersion, 1);
  assert.equal(definition.showThinking, true);
  assert.equal(definition.probe.toolName, 'chess_training_probe');
  assert.equal(definition.validateAnswer, undefined, 'teacher review must not be a host grading hook');
  assert.equal(definition.teach.toolName, 'chess_training_question');
  assert.deepEqual([...handlers.keys()], ['open-puzzle', 'act-puzzle']);
  assert.deepEqual(instructions.map(value => value.agents), [['teacher'], ['prober'], ['teacher', 'prober']]);
  assert.match(instructions[1].text, /chess_training_probe/);
  assert.match(instructions[0].text, /chess_training_question/);
  const parameters = createPluginQuestionParameters(definition, 'teach');
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.required, ['type', 'nodeId', 'question', 'payload']);
  assert.deepEqual(parameters.properties.payload, definition.questionSchema);
  assert.deepEqual(parameters.properties.type.enum, ['predict', 'check']);
  const probeParameters = createPluginQuestionParameters(definition, 'probe');
  assert.equal(probeParameters.additionalProperties, false);
  assert.deepEqual(probeParameters.required, ['question', 'payload']);
  assert.deepEqual(Object.keys(probeParameters.properties).sort(), ['payload', 'question']);
  assert.deepEqual(probeParameters.properties.payload, definition.questionSchema);
  const probeInput = { question: input().question, payload: puzzle() };
  const validateProbe = value => validatePluginQuestionInput(definition, { chatId: 'isolated', variant: 'probe', input: value });
  assert.deepEqual(validateProbe(probeInput).value, probeInput);
  for (const value of [
    { ...probeInput, type: 'predict' }, { ...probeInput, nodeId: 'node' },
    { ...probeInput, question: ' ' }, { ...probeInput, extra: true },
    { question: probeInput.question }, { payload: puzzle() },
    { ...probeInput, payload: { ...puzzle(), fen: 'invalid' } },
    { ...probeInput, payload: { ...puzzle(), lines: [['e2e5']] } },
    { ...probeInput, payload: { ...puzzle(), hints: [] } },
  ]) assert.equal(validateProbe(value).ok, false, JSON.stringify(value));
  const validate = value => validatePluginQuestionInput(definition, { chatId: 'isolated', variant: 'teach', input: value });
  const accepted = validate(input());
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.value, input());
  assert.equal(Object.isFrozen(accepted.value.payload), true);
  for (const value of [
    { ...input(), question: ' ' }, { ...input(), nodeId: '' },
    { ...input(), type: 'probe' }, { ...input(), extra: true },
    { ...input(), payload: { ...puzzle(), fen: 'invalid' } },
    { ...input(), payload: { ...puzzle(), lines: [['e2e5']] } },
    { ...input(), payload: { ...puzzle(), lines: [['e2e4', 'e7e5']] } },
    { ...input(), payload: { ...puzzle(), hints: [] } },
  ]) {
    const result = validate(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.ok(result.problems.every(problem => typeof problem === 'string' && problem.trim()));
  }
  assert.deepEqual(await readdir(f.dataDirectory), [], 'registration/validation must not write progress');
});

test('backend engine distribution is outside public assets and includes exact offline corresponding source', async t => {
  const f = await fixture(t);
  for (const file of ['engine-worker.cjs', 'engine/stockfish-19-lite-single.js', 'engine/stockfish-19-lite-single.wasm',
    'engine/source/stockfish.js-0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6.tar.gz',
    'engine/source/nn-61e7af4bb97d.nnue', 'licenses/stockfish-GPL-3.0.txt', 'licenses/stockfish-network-CC0.txt']) {
    assert.ok(f.packageFiles.includes(file), file);
  }
  assert.equal(f.packageFiles.some(file => file.startsWith('assets/') && /stockfish|wasm/.test(file)), false);
  const frontend = await readFile(join(f.directory, f.manifest.main), 'utf8');
  assert.doesNotMatch(frontend, /stockfish-19|engine-worker|node:worker_threads/);
  const { tools } = activateBackend(t, f);
  assert.deepEqual(tools[1].agents, ['teacher', 'prober']);
  assert.equal(tools[1].create({ chatId: 'external', agent: 'teacher' })[0].name, 'chess_training_analyze');
});

test('external lesson uses teacher-only public native tools and projects its artifact directly without model duplication', async t => {
  const f = await fixture(t);
  const { tools, instructions } = activateBackend(t, f);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0].agents, ['teacher']);
  const [tool] = tools[0].create(Object.freeze({ chatId: 'isolated', agent: 'teacher' }));
  assert.equal(tool.name, 'chess_training_lesson');
  const authored = {
    version: 1, title: 'Central development', explanation: 'Control the center, then develop.',
    fen: puzzle().fen, orientation: 'black',
    annotations: { highlights: [{ square: 'e4', color: 'yellow' }] },
    variations: [{ name: 'Open game', moves: ['e2e4', 'e7e5'], annotations: [
      { ply: 2, explanation: 'Both sides have a center pawn.', arrows: [{ from: 'g1', to: 'f3', color: 'green' }] },
    ] }],
  };
  const check = Compile(tool.parameters);
  assert.equal(check.Check(authored), true);
  for (const invalid of [{ ...authored, version: 2 }, { ...authored, orientation: 'sideways' },
    { ...authored, extra: true }, { ...authored, annotations: { circles: [{ square: 'e4', color: 'purple' }] } }]) {
    assert.equal(check.Check(invalid), false);
  }
  const result = await tool.execute('lesson-call', authored, new AbortController().signal);
  assert.deepEqual(result.details, authored);
  assert.equal(Object.isFrozen(result.details.variations[0].moves), true);
  assert.notEqual(result.details, authored);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Chess lesson presented.' }]);
  const messages = [{
    id: 'lesson-message', role: 'assistant', timestamp: 1, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'lesson-call', name: tool.name, arguments: authored }],
  }, { id: 'lesson-result', role: 'toolResult', toolCallId: 'lesson-call', toolName: tool.name,
    ...result, isError: false, timestamp: 2 }];
  const part = projectView(messages)[0].parts.find(part => part.type === 'tool-chess_training_lesson');
  assert.equal(part.state, 'output-available');
  assert.deepEqual(part.output, authored, 'public renderer output is the artifact, not a wrapper or acknowledgement');
  assert.deepEqual(part.result.content, result.content);
  assert.equal(part.pluginQuestion, undefined, 'lessons must not enter pending-question protocol');
  const model = toLlmMessages(messages);
  assert.deepEqual(model[0].content[0].arguments, authored, 'the model already has its authored lesson');
  assert.deepEqual(model[1].content, result.content, 'result content must not repeat the lesson JSON');
  await assert.rejects(tool.execute('invalid', { ...authored, variations: [{ name: 'Illegal', moves: ['e2e5'] }] }, new AbortController().signal), /legal|move/i);
  assert.match(instructions[0].text, /not the learner's local board exploration/);
  assert.match(instructions[0].text, /fresh independent puzzle/);
  assert.deepEqual(await readdir(f.dataDirectory), [], 'lessons have no backend progress or synchronization store');
});

// The ledger has TS parameter properties, which Node 26 cannot erase. A
// child-local loader transpiles that one host file in memory, never on disk.
async function nativePoseProbe(directory, dataDirectory, hostRoot, variant) {
  const { default: assert } = await import('node:assert/strict');
  const { createRequire, registerHooks } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  globalThis.fetch = () => { throw new Error('Network forbidden in native pose probe'); };
  const hostRequire = createRequire(join(hostRoot, 'package.json'));
  const ts = hostRequire('typescript');
  const ledgerURL = pathToFileURL(join(hostRoot, 'src/agent/plugin-question-tools.ts')).href;
  registerHooks({ load(url, context, nextLoad) {
    if (url !== ledgerURL) return nextLoad(url, context);
    const loaded = nextLoad(url, context);
    return { ...loaded, format: 'module', source: ts.transpileModule(String(loaded.source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
  } });
  const { PluginQuestionLedger } = await import(pathToFileURL(join(hostRoot, 'src/agent/plugin-question-tools.ts')).href);
  const { preparePluginQuestionType, readPluginQuestionMessageAnnotation } = await import(pathToFileURL(join(hostRoot, 'src/core/plugin-questions.ts')).href);
  let definition;
  const dispose = createRequire(import.meta.url)(join(directory, 'backend.cjs')).activate({
    dataDirectory, signal: new AbortController().signal,
    handle() { return () => {}; }, registerInstructions() { return () => {}; },
    registerTools() { return () => {}; },
    registerQuestionType(value) { definition = preparePluginQuestionType(value); return () => {}; },
  });
  try {
    const ledger = new PluginQuestionLedger([{
      pluginId: 'chess-training', definition, variant,
      signal: new AbortController().signal, requireActive() {},
    }], 'isolated', nodeId => nodeId === 'node');
    let emit;
    ledger.bind({ subscribe(listener) { emit = listener; return () => {}; } });
    assert.equal(ledger.tools.length, 1);
    const tool = ledger.tools[0];
    assert.equal(tool.name, variant === 'probe' ? 'chess_training_probe' : 'chess_training_question');
    const good = {
      question: 'Find the best continuation.', type: 'predict', nodeId: 'node',
      payload: {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        lines: [['e2e4', 'e7e5', 'g1f3']], hints: [['Center'], ['Develop']],
      },
    };
    if (variant === 'probe') { delete good.type; delete good.nodeId; }
    const bad = { ...good, payload: { ...good.payload, lines: [['e2e5']] } };
    const calls = [bad, good].map((args, index) => ({ type: 'toolCall', id: `call-${index}`, name: tool.name, arguments: args }));
    const message = { role: 'assistant', content: calls };
    emit({ type: 'message_start', message });
    const results = [];
    for (let index = 0; index < calls.length; index++) {
      const args = structuredClone(calls[index].arguments);
      ledger.validatedCall({ assistantMessage: message, toolCall: calls[index], args });
      if (index === 1) await assert.rejects(tool.execute(calls[index].id, structuredClone(args)), /occurrence unavailable/);
      results.push(await tool.execute(calls[index].id, args));
    }
    assert.equal(results[0].isError, true);
    assert.equal(ledger.isAcknowledgment(results[0]), false);
    assert.equal(ledger.isAcknowledgment(results[1]), true);
    const live = ledger.wire({ type: 'message_end', message }, { type: 'message_end', message });
    assert.equal(live.message.lhQuestions[1].questionId, undefined, 'wire visibility grants no pending authority');
    const [settled] = ledger.settled([message], [{ ...message, id: 'canonical-message', content: calls.map(call => ({ ...call, id: `${call.id}~2` })) }]);
    const failed = readPluginQuestionMessageAnnotation(settled, 0);
    assert.equal(failed.status, 'attempt');
    assert.equal(settled.lhQuestions[0].questionId, undefined);
    const posed = readPluginQuestionMessageAnnotation(settled, 1);
    assert.equal(posed.status, 'posed');
    assert.match(posed.snapshot.questionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(posed.snapshot.occurrence, { messageId: 'canonical-message', contentIndex: 1, toolCallId: 'call-1~2', toolName: tool.name });
    assert.equal(posed.snapshot.variant, variant);
    assert.deepEqual(posed.snapshot.input, good);
    assert.equal(posed.snapshot.requiresAnswerRefinement, false);
    assert.equal(posed.snapshot.showThinking, true);
    assert.equal(ledger.settled([message], [settled])[0].lhQuestions[1].questionId, posed.snapshot.questionId);
    assert.equal(ledger.wire({ type: 'tool_execution_end', result: results[1] }, { type: 'tool_execution_end', result: results[1] }), undefined);
    return posed.snapshot;
  } finally { await dispose(); }
}

for (const variant of ['teach', 'probe']) test(`native ${variant} ledger settles canonical occurrences; historical answers are format-only and round-trip publicly`, async t => {
  const f = await fixture(t);
  const script = `const snapshot = await (${nativePoseProbe.toString()})(${JSON.stringify(f.directory)}, ${JSON.stringify(f.dataDirectory)}, ${JSON.stringify(hostRoot)}, ${JSON.stringify(variant)}); console.log(JSON.stringify(snapshot));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: f.root, timeout: 30000,
    env: { ...process.env, NODE_OPTIONS: '', LH_DATA_DIR: join(f.root, 'host-data'), LH_AUTH_FILE: join(f.root, 'auth.json') },
  });
  const snapshot = readPluginQuestionSnapshot(JSON.parse(stdout));
  assert.ok(snapshot);
  const incorrect = { moves: ['d2d4'], incorrectAttempts: [{ atPly: 0, move: 'bad move' }], revealedHints: [] };
  assert.equal(validatePluginQuestionAnswer(snapshot, { chatId: 'isolated', answer: incorrect }).ok, true);
  assert.equal(validatePluginQuestionAnswer(snapshot, { chatId: 'isolated', answer: { moves: [], incorrectAttempts: [], revealedHints: [] } }).ok, true);
  const envelope = {
    kind: 'plugin-question', questionId: snapshot.questionId, pluginId: snapshot.pluginId,
    typeId: snapshot.typeId, contractVersion: snapshot.contractVersion, answer: incorrect,
    thinking: 'I considered a different center pawn.', answeredAt: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(readPluginQuestionAnswer(JSON.parse(JSON.stringify(envelope)), snapshot), envelope);
  assert.equal(readPluginQuestionAnswer({ ...envelope, questionId: 'different' }, snapshot), null);
  assert.equal(readPluginQuestionAnswer({ ...envelope, readingThinking: 'Not a check question' }, snapshot), null);
  for (const answer of [
    { ...incorrect, moves: ['not-uci'] }, { ...incorrect, moves: ['E2E4'] },
    { ...incorrect, incorrectAttempts: [{ atPly: -1, move: 'd2d4' }] },
    { ...incorrect, revealedHints: [{ learnerMove: 0, count: 'one' }] },
    { ...incorrect, correctness: true },
  ]) {
    assert.equal(validatePluginQuestionAnswer(snapshot, { chatId: 'isolated', answer }).ok, false);
    assert.equal(readPluginQuestionAnswer({ ...envelope, answer }, snapshot), null);
  }
  assert.deepEqual(await readdir(f.dataDirectory), []);
});

test('external frontend activates public puzzle and lesson renderers without side effects', async t => {
  const f = await fixture(t);
  const before = await files(f.directory);
  const renderers = [];
  const toolRenderers = [];
  let removed = 0;
  const cleanup = () => { removed++; };
  const frontend = await import(pathToFileURL(join(f.directory, f.manifest.main)).href);
  const dispose = await frontend.activate(new Proxy({
    registerQuestionRenderer(renderer) { renderers.push(renderer); return cleanup; },
    registerToolRenderer(renderer) { toolRenderers.push(renderer); return cleanup; },
  }, {
    get(target, key) {
      assert.ok(['registerQuestionRenderer', 'registerToolRenderer'].includes(key), `Unexpected activation API: ${String(key)}`);
      return target[key];
    },
  }));
  assert.equal(renderers.length, 1);
  const renderer = renderers[0];
  assert.equal(renderer.id, 'puzzle');
  assert.deepEqual(renderer.supportedContractVersions, [1]);
  assert.deepEqual(Object.keys(renderer).sort(), ['id', 'mountAnswerEditor', 'mountAnswered', 'supportedContractVersions'].sort());
  assert.equal(renderer.mountQuestion, undefined, 'no raw authored payload/duplicate question slot');
  assert.equal(typeof renderer.mountAnswerEditor, 'function');
  assert.equal(typeof renderer.mountAnswered, 'function');
  assert.equal(toolRenderers.length, 1);
  assert.equal(toolRenderers[0].toolName, 'chess_training_lesson');
  assert.equal(typeof toolRenderers[0].mount, 'function');
  assert.deepEqual(Object.keys(toolRenderers[0]).sort(), ['mount', 'toolName']);
  assert.deepEqual(await files(f.directory), before);
  assert.deepEqual(await readdir(f.dataDirectory), []);
  await dispose();
  assert.equal(removed, 2);
  await dispose();
  assert.equal(removed, 2);
});

test('external distribution scopes every CSS selector, embeds artwork, and carries complete source and licenses', async t => {
  const f = await fixture(t);
  const css = (await readFile(join(f.directory, f.manifest.styles), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  // Embedded SVGs contain braces/commas: remove URL bodies before parsing flat rules.
  const urls = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gs)].map(match => match[2]);
  assert.equal(urls.length, 12);
  assert.equal(new Set(urls).size, 12);
  for (const url of urls) assert.match(url, /^data:image\/svg\+xml[,;]/);
  const flat = css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gs, 'url(embedded)');
  assert.doesNotMatch(flat, /@(?:import|font-face|keyframes|media|supports)\b/);
  const rules = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 12);
  assert.equal(flat.replace(/([^{}]+)\{([^{}]*)\}/g, '').trim(), '');
  for (const [, selectors] of rules) {
    for (const selector of selectors.split(',')) assert.match(selector.trim(), /^\.chess-training(?=$|[\s.:#\[])/, selector);
  }
  assert.doesNotMatch(flat, /(?:https?:)?\/\//);
  for (const entry of [f.manifest.main, f.manifest.backend]) {
    const bundle = await readFile(join(f.directory, entry), 'utf8');
    assert.doesNotMatch(bundle, /\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?["'][^"']+["']/);
    assert.doesNotMatch(bundle, /\bimport\s*\(/);
    for (const [, dependency] of bundle.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
      assert.equal(isBuiltin(dependency), true, `${entry} depends on external ${dependency}`);
    }
    assert.doesNotMatch(bundle, /(?:\.\.\/)+src\/(?:core|agent|server)\//);
  }
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md',
    'licenses/chessground-GPL-3.0.txt', 'licenses/chessops-GPL-3.0.txt', 'licenses/badrap-result-MIT.txt']) {
    assert.deepEqual(await readFile(join(f.directory, name)), await readFile(join(pluginRoot, name)), name);
  }
  for (const dependency of ['@lichess-org/chessground', 'chessops', '@badrap/result']) {
    const source = join(pluginRoot, 'node_modules', dependency);
    const bundled = join(f.directory, 'source/vendor', dependency);
    const names = await files(source);
    assert.deepEqual(await files(bundled), names, `Complete vendor source: ${dependency}`);
    for (const name of names) assert.deepEqual(await readFile(join(bundled, name)), await readFile(join(source, name)), `${dependency}/${name}`);
  }
  const correspondingSource = ['package.json', 'package-lock.json'];
  for (const directory of ['src', 'scripts', 'tests']) {
    correspondingSource.push(...(await files(join(pluginRoot, directory))).map(name => join(directory, name)));
  }
  for (const name of correspondingSource) {
    assert.deepEqual(await readFile(join(f.directory, 'source', name)), await readFile(join(pluginRoot, name)), `Corresponding source (rebuild after edits): ${name}`);
  }
});
