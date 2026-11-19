import { Chessground } from '@lichess-org/chessground';
import { makeFen } from 'chessops/fen';
import { startPosition, legalMove } from './core.js';

/** Replay accepted moves only, independent of mutable progress and authored alternatives. */
export function mountReplay(ctx, container, props, createBoard = Chessground) {
  const doc = container.ownerDocument;
  const positions = [];
  let orientation;
  try {
    const pos = startPosition(props.input.payload.fen);
    orientation = pos.turn;
    positions.push(makeFen(pos.toSetup()));
    for (const uci of props.answer.moves) {
      const move = legalMove(pos, uci);
      if (!move) throw new Error('Unplayable saved move');
      pos.play(move);
      positions.push(makeFen(pos.toSetup()));
    }
  } catch {
    const notice = doc.createElement('p');
    notice.textContent = 'Replay unavailable: the saved moves cannot be played from this position.';
    container.append(notice);
    return () => notice.remove();
  }
  const local = new doc.defaultView.AbortController();
  let disposed = false;
  let board;
  let ply = positions.length - 1;
  const toggle = doc.createElement('button');
  toggle.type = 'button'; toggle.textContent = 'Show board';
  toggle.setAttribute('aria-expanded', 'false');
  const panel = doc.createElement('section');
  panel.setAttribute('aria-label', 'Puzzle replay'); panel.hidden = true;
  const element = doc.createElement('div'); element.className = 'cg-wrap chess-training-board';
  element.setAttribute('aria-label', 'Read-only puzzle replay board');
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const navigation = doc.createElement('div'); navigation.className = 'chess-training-entry';
  function button(label, delta) {
    const b = doc.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => { if (!disposed) { ply = Math.max(0, Math.min(positions.length - 1, ply + delta)); render(); } }, { signal: local.signal });
    navigation.append(b); return b;
  }
  const back = button('Previous move', -1);
  const next = button('Next move', 1);
  function render() {
    board?.set({ fen: positions[ply], lastMove: ply ? [props.answer.moves[ply - 1].slice(0, 2), props.answer.moves[ply - 1].slice(2, 4)] : undefined });
    status.textContent = `Move ${ply} of ${positions.length - 1}${ply ? ': ' + props.answer.moves[ply - 1] : ': starting position'}`;
    back.disabled = ply === 0; next.disabled = ply === positions.length - 1;
  }
  panel.append(element, status, navigation); container.append(toggle, panel);
  toggle.addEventListener('click', () => {
    if (disposed) return;
    panel.hidden = !panel.hidden;
    toggle.textContent = panel.hidden ? 'Show board' : 'Hide board';
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) { board?.destroy(); board = undefined; return; }
    ply = positions.length - 1;
    board = createBoard(element, { fen: positions[ply], orientation, coordinates: true,
      viewOnly: true, movable: { free: false, dests: new Map() },
      draggable: { enabled: false }, selectable: { enabled: false },
      drawable: { enabled: false }, animation: { enabled: false } });
    render();
  }, { signal: local.signal });
  function dispose() {
    if (disposed) return;
    disposed = true; local.abort(); board?.destroy(); board = undefined;
    props.signal.removeEventListener('abort', dispose); ctx.signal.removeEventListener('abort', dispose);
    toggle.remove(); panel.remove();
  }
  props.signal.addEventListener('abort', dispose, { once: true });
  ctx.signal.addEventListener('abort', dispose, { once: true });
  if (props.signal.aborted || ctx.signal.aborted) dispose();
  return dispose;
}
