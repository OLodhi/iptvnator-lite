import type { Programme } from '@tv/shared';

export const PX_PER_MIN = 3, ROW_HEIGHT = 56, CHANNEL_COL = 72, SLOT_MIN = 30, PAGE_SEC = 6 * 3600;

export type Block = { programme: Programme; left: number; width: number; state: 'past' | 'now' | 'future' };

const SLOT_SEC = SLOT_MIN * 60;
const MIN_WIDTH = 2;

/** Pixels from `fromSec` to `sec` on the time axis. */
export const offsetPx = (sec: number, fromSec: number): number => ((sec - fromSec) / 60) * PX_PER_MIN;

/** Blocks for the programmes that overlap the window, clipped to it; `left` is from the window start. */
export function layoutProgrammes(programmes: Programme[], windowStartSec: number, windowEndSec: number, nowSec: number): Block[] {
  const blocks: Block[] = [];
  for (const programme of programmes) {
    if (programme.stopSec <= windowStartSec || programme.startSec >= windowEndSec) continue;
    const start = Math.max(programme.startSec, windowStartSec);
    const stop = Math.min(programme.stopSec, windowEndSec);
    blocks.push({
      programme,
      left: offsetPx(start, windowStartSec),
      width: Math.max(MIN_WIDTH, offsetPx(stop, start)),
      state: programme.stopSec <= nowSec ? 'past' : programme.startSec <= nowSec ? 'now' : 'future',
    });
  }
  return blocks;
}

/** The opening window: from the half hour at or before an hour ago, one page wide. */
export function initialWindow(nowSec: number): { from: number; to: number } {
  const from = Math.floor((nowSec - 3600) / SLOT_SEC) * SLOT_SEC;
  return { from, to: from + PAGE_SEC };
}
