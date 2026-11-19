import { Chessground } from '@lichess-org/chessground';
import { mountLesson } from './lesson.js';
import { mountReplay } from './replay.js';
import { makeFen } from 'chessops/fen';
import { chessgroundDests } from 'chessops/compat';
import { parseSquare } from 'chessops/util';
import { initialState, validatePuzzle, validateState, position, isComplete, usedHints, attemptMove } from './core.js';

const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Backend snapshots, never host memory drafts, are the durable source of progress.
 * Controlled updates affect presentation only and never cause writes or echo onChange.
 */
export function mountEditor(ctx, container, props, createBoard = Chessground) {
  validatePuzzle(props.input.payload);
  const payload = props.input.payload;
  const identity = { chatId: props.chatId, questionId: props.questionId, contractVersion: props.contractVersion };
  const doc = container.ownerDocument;
  let current = props;
  let state = initialState();
  let snapshot;
  let disposed = false;
  let busy = true;
  let failed = false;
  let promotion;
  let board;
  let generation = 0;
  const root = doc.createElement('section');
  root.className = 'chess-training';
  root.setAttribute('aria-label', 'Chess puzzle');
  const boardElement = doc.createElement('div');
  boardElement.className = 'cg-wrap chess-training-board';
  boardElement.setAttribute('aria-label', 'Chessboard; moves can also be entered in the UCI field below');
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const moves = doc.createElement('p');
  moves.className = 'chess-training-moves';
  const entry = doc.createElement('div');
  entry.className = 'chess-training-entry';
  const label = doc.createElement('label');
  label.textContent = 'UCI move ';
  const field = doc.createElement('input');
  field.type = 'text'; field.placeholder = 'e2e4 or a7a8n';
  field.setAttribute('aria-label', 'UCI move'); field.autocomplete = 'off'; field.spellcheck = false;
  label.append(field);
  function button(text, callback, parent = entry) {
    const element = doc.createElement('button');
    element.type = 'button'; element.textContent = text;
    element.addEventListener('click', callback, { signal: local.signal });
    parent.append(element);
    return element;
  }
  const local = new AbortController();
  entry.append(label);
  const play = button('Play move', () => { void act({ type: 'move', uci: field.value }); });
  const hint = button('?', () => { void act({ type: 'hint' }); });
  hint.title = 'Reveal the next hint for this move';
  hint.setAttribute('aria-label', 'Reveal next hint');
  const retry = button('Reload saved progress', () => { void load(); });
  const promotionElement = doc.createElement('div');
  promotionElement.className = 'chess-training-promotion';
  promotionElement.setAttribute('role', 'group');
  promotionElement.setAttribute('aria-label', 'Choose promotion piece');
  const promotionLabel = doc.createElement('span'); promotionLabel.textContent = 'Promote to: ';
  promotionElement.append(promotionLabel);
  const promotionButtons = ['q', 'r', 'b', 'n'].map((piece, index) => button(['Queen', 'Rook', 'Bishop', 'Knight'][index], () => {
    if (!promotion || !eligible()) return;
    const uci = promotion + piece; promotion = undefined;
    void act({ type: 'move', uci });
  }, promotionElement));
  const hintList = doc.createElement('ol');
  hintList.className = 'chess-training-hints';
  root.append(boardElement, status, moves, entry, promotionElement, hintList);
  container.append(root);

  const live = () => !disposed && !props.signal.aborted && !ctx.signal.aborted;
  const complete = () => isComplete(payload, state);
  const eligible = () => live() && current.active && !!snapshot && !busy && !failed && !complete();
  function publish() {
    if (!live()) return;
    current.onChange({ status: snapshot && !busy && !failed && complete() ? 'ready' : 'unready', value: clone(state) });
  }
  function render() {
    if (!live()) return;
    const pos = position(payload, state);
    board?.set({
      fen: makeFen(pos.toSetup()), turnColor: pos.turn,
      check: pos.isCheck(), lastMove: state.moves.length ? [state.moves.at(-1).slice(0, 2), state.moves.at(-1).slice(2, 4)] : [],
      movable: { color: eligible() && !promotion ? pos.turn : undefined, dests: eligible() && !promotion ? chessgroundDests(pos) : new Map() },
      draggable: { enabled: eligible() && !promotion }, selectable: { enabled: eligible() && !promotion },
    });
    field.disabled = play.disabled = !eligible() || !!promotion;
    hint.disabled = !eligible() || !!promotion || (state.revealedHints.find(h => h.learnerMove === state.moves.length / 2)?.count ?? 0) >= (payload.hints[state.moves.length / 2]?.length ?? 0);
    retry.hidden = !failed; retry.disabled = busy || !current.active;
    promotionElement.hidden = !promotion;
    promotionButtons.forEach(button => { button.disabled = !eligible(); });
    moves.textContent = `Moves: ${state.moves.join(' ') || '—'} · Recorded retries: ${state.incorrectAttempts.length}`;
    hintList.replaceChildren(...usedHints(payload, state).map(h => {
      const item = doc.createElement('li'); item.textContent = `Move ${h.learnerMove + 1}: ${h.text}`; return item;
    }));
  }
  function accept(result) {
    if (!result || typeof result.lease !== 'string' || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('Invalid saved puzzle response.');
    validateState(payload, result.state);
    snapshot = { lease: result.lease, revision: result.revision };
    state = clone(result.state);
  }
  async function load() {
    if (!live() || (busy && snapshot)) return;
    const attempt = ++generation;
    busy = true; failed = false; promotion = undefined;
    status.textContent = 'Loading saved progress…'; publish(); render();
    try {
      const result = await ctx.call('open-puzzle', { identity, payload });
      if (!live() || attempt !== generation) return;
      accept(result); busy = false;
      status.textContent = complete() ? 'Puzzle complete. Use the normal Submit button when ready.' : `${position(payload, state).turn === 'white' ? 'White' : 'Black'} to move.`;
      publish(); render();
    } catch (error) {
      if (!live() || attempt !== generation) return;
      busy = false; failed = true;
      status.textContent = `Could not load saved progress: ${error.message}`; publish(); render();
    }
  }
  async function act(event) {
    if (!eligible() || promotion) return;
    const attempt = ++generation;
    // Show local feedback and roll the board back immediately; readiness still waits for durable acknowledgment.
    busy = true; status.textContent = event.type === 'move' ? `${attemptMove(payload, state, event.uci).feedback} Saving progress…` : 'Saving hint…'; publish(); render();
    try {
      const result = await ctx.call('act-puzzle', { identity, payload, ...snapshot, event });
      if (!live() || attempt !== generation) return;
      accept(result); busy = false;
      if (event.type === 'move' && result.accepted) field.value = '';
      status.textContent = complete() ? 'Puzzle complete. Use the normal Submit button when ready.' : result.feedback;
      publish(); render();
    } catch (error) {
      if (!live() || attempt !== generation) return;
      busy = false; failed = true;
      status.textContent = `Progress could not be confirmed: ${error.message}. Reload saved progress before retrying.`;
      publish(); render();
    }
  }
  board = createBoard(boardElement, {
    fen: payload.fen, orientation: position(payload, state).turn,
    coordinates: true, autoCastle: true,
    animation: { enabled: false },
    movable: { free: false, rookCastle: false, dests: new Map(), events: { after(from, to) {
      if (!eligible() || promotion) { render(); return; }
      const pos = position(payload, state);
      if (pos.board.get(parseSquare(from))?.role === 'pawn' && /[18]$/.test(to)) {
        promotion = from + to; status.textContent = 'Choose a promotion piece.'; render();
      } else void act({ type: 'move', uci: from + to });
    } } },
    premovable: { enabled: false }, predroppable: { enabled: false }, drawable: { enabled: false },
    draggable: { enabled: false }, selectable: { enabled: false },
  });
  root.addEventListener('keydown', event => {
    if (event.key === '?' && event.target !== field && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !hint.disabled) {
      event.preventDefault(); void act({ type: 'hint' });
    }
  }, { signal: local.signal });
  function dispose() {
    if (disposed) return;
    disposed = true; generation++; local.abort();
    props.signal.removeEventListener('abort', dispose);
    ctx.signal.removeEventListener('abort', dispose);
    board.destroy(); root.remove();
  }
  props.signal.addEventListener('abort', dispose, { once: true });
  ctx.signal.addEventListener('abort', dispose, { once: true });
  if (live()) void load(); else dispose();
  return {
    update(next) {
      if (!live()) return;
      current = { ...current, ...next };
      // Incoming memory drafts must never write to the backend or race durable restoration.
      if (!busy && !failed && next.answer?.status !== 'empty' && next.answer?.value !== undefined && !same(next.answer.value, state)) {
        validateState(payload, next.answer.value); state = clone(next.answer.value);
      }
      render();
    },
    focus() { if (live() && current.active) field.focus(); },
    handleKeyDown(key) {
      if (!live() || !current.active) return 'pass';
      if (key === 'Escape' && promotion) { promotion = undefined; status.textContent = 'Promotion cancelled. Try your move again.'; render(); return 'handled'; }
      if (key === 'Enter' && doc.activeElement === field) { void act({ type: 'move', uci: field.value }); return 'handled'; }
      return 'pass';
    },
    dispose,
  };
}

// The search result holds solutions for the agent; the learner-facing card shows only a summary.
export function mountPuzzleSearch(container, props) {
  const text = container.ownerDocument.createElement('p');
  text.className = 'chess-training';
  if (props.state !== 'output-available') text.textContent = props.state === 'output-error' ? `Puzzle search failed: ${props.errorText || 'Tool failed.'}` : 'Choosing chess puzzles…';
  else {
    const picked = Array.isArray(props.output?.puzzles) ? props.output.puzzles : [];
    const ratings = picked.map(p => p.rating).filter(Number.isFinite);
    text.textContent = picked.length
      ? `Chess puzzle bank: picked ${picked.length} of ${props.output.matched} matching (rating ${Math.min(...ratings)}–${Math.max(...ratings)}).`
      : 'Chess puzzle bank: no matching puzzles.';
  }
  container.append(text);
  return () => text.remove();
}

export function activate(ctx) {
  const unregisterLesson = ctx.registerToolRenderer({
    toolName: 'chess_training_lesson',
    mount: (container, props) => mountLesson(ctx, container, props),
  });
  const unregisterQuestion = ctx.registerQuestionRenderer({
    id: 'puzzle', supportedContractVersions: [1],
    // Omit mountQuestion: the native Markdown condition is the only public question text.
    mountAnswerEditor: (container, props) => mountEditor(ctx, container, props),
    mountAnswered(container, props) {
      const root = container.ownerDocument.createElement('div'); root.className = 'chess-training';
      const text = container.ownerDocument.createElement('p');
      text.textContent = `Moves: ${props.answer.moves.join(' ')} · Recorded retries: ${props.answer.incorrectAttempts.length}`;
      const hints = container.ownerDocument.createElement('ul');
      for (const record of props.answer.revealedHints) {
        // Answer rendering is format-only too: do not require matching an authored solution.
        for (const value of props.input.payload.hints[record.learnerMove]?.slice(0, record.count) ?? []) {
          const item = container.ownerDocument.createElement('li'); item.textContent = `Move ${record.learnerMove + 1}: ${value}`; hints.append(item);
        }
      }
      const attempts = container.ownerDocument.createElement('p');
      attempts.textContent = props.answer.incorrectAttempts.map(a => `Ply ${a.atPly + 1}: ${a.move}`).join('; ');
      root.append(text, attempts, hints); container.append(root);
      const disposeReplay = mountReplay(ctx, root, props);
      return () => { disposeReplay(); root.remove(); };
    },
  });
  const unregisterSearch = ctx.registerToolRenderer({ toolName: 'chess_training_find_puzzles', mount: mountPuzzleSearch });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unregisterQuestion();
    unregisterLesson();
    unregisterSearch();
  };
}
