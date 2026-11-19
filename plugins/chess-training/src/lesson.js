import { Chessground } from '@lichess-org/chessground';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { chessgroundDests } from 'chessops/compat';
import { parseSquare } from 'chessops/util';
import { validateLesson, createLessonController } from './lesson-core.js';

/** Each native tool occurrence owns a disposable, memory-only exploration. */
export function mountLesson(ctx, container, props, createBoard = Chessground) {
  const doc = container.ownerDocument;
  const root = doc.createElement('section');
  root.className = 'chess-training chess-training-lesson';
  root.setAttribute('aria-label', 'Interactive chess lesson');
  const local = new AbortController();
  let disposed = false;
  let board;
  let promotion;
  const live = () => !disposed && !props.signal.aborted && !ctx.signal.aborted;
  function element(tag, text, parent = root) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    local.abort();
    props.signal.removeEventListener('abort', dispose);
    ctx.signal.removeEventListener('abort', dispose);
    board?.destroy();
    root.remove();
  }
  props.signal.addEventListener('abort', dispose, { once: true });
  ctx.signal.addEventListener('abort', dispose, { once: true });
  if (!live()) { dispose(); return dispose; }
  container.append(root);
  if (props.state !== 'output-available') {
    element('p', props.state === 'output-error' ? `Lesson unavailable: ${props.errorText || 'Tool failed.'}` : 'Preparing chess lesson…');
    return dispose;
  }
  let lesson, controller;
  try {
    // Never mount from streaming input or unwrap a guessed result shape.
    lesson = validateLesson(props.output);
    controller = createLessonController(lesson);
  } catch (error) {
    element('p', `Lesson unavailable: ${error.message}`);
    return dispose;
  }
  element('h3', lesson.title);
  element('p', lesson.explanation).className = 'chess-training-lesson-explanation';
  element('p', 'Exploration is memory-only. Moves are not saved or submitted; remounting restores the authored lesson.').className = 'chess-training-memory';
  const boardElement = element('div');
  boardElement.className = 'cg-wrap chess-training-board';
  boardElement.setAttribute('aria-label', 'Chessboard; use the UCI move field for keyboard moves');
  const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const annotation = element('p'); annotation.className = 'chess-training-annotation';
  const annotationList = element('ul'); annotationList.className = 'chess-training-annotation-list';
  const moves = element('p'); moves.className = 'chess-training-moves';
  const entry = element('div'); entry.className = 'chess-training-entry';
  const label = element('label', 'UCI move ', entry);
  const field = element('input', undefined, label);
  field.type = 'text'; field.placeholder = 'e2e4 or a7a8n'; field.autocomplete = 'off'; field.spellcheck = false;
  field.setAttribute('aria-label', 'UCI move');
  function button(text, callback, parent = entry) {
    const node = element('button', text, parent); node.type = 'button';
    node.addEventListener('click', () => { if (live()) callback(); }, { signal: local.signal });
    return node;
  }
  const play = button('Play move', () => playMove(field.value));
  const undo = button('Undo', () => act(() => controller.undo()));
  button('Reset', () => act(() => controller.reset()));
  const promotionElement = element('div'); promotionElement.className = 'chess-training-promotion';
  promotionElement.setAttribute('role', 'group'); promotionElement.setAttribute('aria-label', 'Choose promotion piece');
  element('span', 'Promote to: ', promotionElement);
  for (const [piece, name] of [['q', 'Queen'], ['r', 'Rook'], ['b', 'Bishop'], ['n', 'Knight']]) {
    button(name, () => { if (promotion) playMove(promotion + piece); }, promotionElement);
  }
  button('Cancel promotion', () => { promotion = undefined; render(); }, promotionElement);
  const navigation = element('div'); navigation.className = 'chess-training-entry';
  const variationLabel = element('label', 'Variation ', navigation);
  const variations = element('select', undefined, variationLabel);
  variations.setAttribute('aria-label', 'Lesson variation');
  const placeholder = element('option', 'Choose variation', variations); placeholder.value = ''; placeholder.disabled = true;
  lesson.variations.forEach((variation, index) => { element('option', variation.name, variations).value = String(index); });
  variations.addEventListener('change', () => { if (live()) act(() => controller.selectVariation(Number(variations.value))); }, { signal: local.signal });
  const previous = button('Previous ply', () => act(() => controller.step(controller.snapshot().ply - 1)), navigation);
  const next = button('Next ply', () => act(() => controller.step(controller.snapshot().ply + 1)), navigation);
  const ply = element('span', '', navigation);
  function render(message) {
    if (!live()) return;
    const s = controller.snapshot();
    const pos = Chess.fromSetup(parseFen(s.fen).unwrap()).unwrap();
    board?.set({
      fen: s.fen, turnColor: s.turn, check: s.check, selected: undefined,
      lastMove: s.moves.length ? [s.moves.at(-1).slice(0, 2), s.moves.at(-1).slice(2, 4)] : [],
      movable: { color: promotion ? undefined : s.turn, dests: promotion ? new Map() : chessgroundDests(pos) },
      draggable: { enabled: !promotion }, selectable: { enabled: !promotion },
      drawable: { autoShapes: [
        ...s.annotations.arrows.map(a => ({ orig: a.from, dest: a.to, brush: a.color })),
        ...s.annotations.circles.map(a => ({ orig: a.square, brush: a.color })),
      ] },
      highlight: { custom: new Map(s.annotations.highlights.map(a => [a.square, `chess-training-highlight-${a.color}`])) },
    });
    status.textContent = message || (promotion ? 'Choose a promotion piece.' : `${s.turn === 'white' ? 'White' : 'Black'} to move${s.check ? ' — check' : ''}.`);
    field.disabled = play.disabled = !!promotion;
    undo.disabled = s.moves.length === 0;
    promotionElement.hidden = !promotion;
    annotation.textContent = s.annotations.explanation || '';
    annotation.hidden = !s.annotations.explanation;
    // Keep authored markings readable without relying on color or pointer input.
    annotationList.replaceChildren();
    for (const a of s.annotations.arrows) element('li', `${a.color} arrow: ${a.from} → ${a.to}`, annotationList);
    for (const a of s.annotations.circles) element('li', `${a.color} circle: ${a.square}`, annotationList);
    for (const a of s.annotations.highlights) element('li', `${a.color} highlight: ${a.square}`, annotationList);
    moves.textContent = `Moves: ${s.moves.join(' ') || '—'}`;
    variations.value = s.variation === null ? '' : String(s.variation);
    variations.disabled = !lesson.variations.length;
    previous.disabled = s.variation === null || s.ply === 0;
    next.disabled = s.variation === null || s.ply >= lesson.variations[s.variation].moves.length;
    ply.textContent = s.variation === null ? 'Free exploration' : `Ply ${s.ply} / ${lesson.variations[s.variation].moves.length}`;
  }
  function act(operation) {
    if (!live()) return;
    promotion = undefined;
    try { operation(); render(); } catch (error) { render(error.message); }
  }
  function playMove(uci) {
    if (!live()) return;
    act(() => { controller.move(uci); field.value = ''; });
  }
  root.addEventListener('keydown', event => {
    if (!live() || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Enter' && event.target === field) {
      event.preventDefault(); event.stopPropagation(); playMove(field.value);
    } else if (event.key === 'Escape' && promotion) {
      event.preventDefault(); event.stopPropagation(); promotion = undefined; render('Promotion cancelled.');
    }
  }, { signal: local.signal });
  try {
    board = createBoard(boardElement, {
      fen: lesson.fen, orientation: lesson.orientation, coordinates: true, autoCastle: true,
      animation: { enabled: false },
      movable: { free: false, rookCastle: false, events: { after(from, to) {
        if (!live()) return;
        if (promotion) { render(); return; }
        const pos = Chess.fromSetup(parseFen(controller.snapshot().fen).unwrap()).unwrap();
        if (pos.board.get(parseSquare(from))?.role === 'pawn' && /[18]$/.test(to)) {
          promotion = from + to; render();
        } else playMove(from + to);
      } } },
      premovable: { enabled: false }, predroppable: { enabled: false },
      drawable: { enabled: false, visible: true },
    });
    render();
  } catch (error) { dispose(); throw error; }
  return dispose;
}
