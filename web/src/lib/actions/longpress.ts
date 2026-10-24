export type LongPressParams = { ms?: number; onLongPress: () => void };

const MOVE_TOLERANCE_PX = 10;

/**
 * Fires `onLongPress` after the pointer is held for `ms` (default 500) without moving more than 10 px,
 * and swallows the click that follows. Uses Pointer Events (iOS 13+) and blocks the native callout.
 * Pair with `-webkit-touch-callout: none; user-select: none` on the element.
 */
export function longpress(node: HTMLElement, initial: LongPressParams) {
  let params = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clearSuppress: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const onDown = (e: PointerEvent) => {
    cancel();
    clearTimeout(clearSuppress);
    suppressClick = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      timer = undefined;
      suppressClick = true;
      params.onLongPress();
    }, params.ms ?? 500);
  };
  const onMove = (e: PointerEvent) => {
    if (timer === undefined) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE_PX) cancel();
  };
  const onUp = () => {
    cancel();
    if (suppressClick) {
      // If no click follows (common on iOS), do not eat an unrelated later tap.
      clearSuppress = setTimeout(() => (suppressClick = false), 600);
    }
  };
  const onClick = (e: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onContextMenu = (e: Event) => e.preventDefault();

  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onUp);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('click', onClick, true);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(next: LongPressParams) {
      params = next;
    },
    destroy() {
      cancel();
      clearTimeout(clearSuppress);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      node.removeEventListener('pointerleave', cancel);
      node.removeEventListener('click', onClick, true);
      node.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
