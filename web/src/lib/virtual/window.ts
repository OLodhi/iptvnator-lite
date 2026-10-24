export type RangeInput = {
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  columns: number;
  count: number;
  /** Extra rows rendered beyond each edge of the viewport. */
  overscan?: number;
};

export type Range = {
  /** First item index to render. */
  start: number;
  /** One past the last item index to render. */
  end: number;
  padTop: number;
  padBottom: number;
};

/**
 * Which items to render for a window-scrolled list. `scrollTop` is the scroll position
 * relative to the top of the list (negative while the list is still below the fold).
 */
export function visibleRange(input: RangeInput): Range {
  const { scrollTop, viewport, rowHeight, count } = input;
  const columns = Math.max(1, input.columns);
  const overscan = input.overscan ?? 6;
  const totalRows = Math.ceil(count / columns);
  if (totalRows === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  const firstRow = Math.min(totalRows, Math.max(0, Math.floor(scrollTop / rowHeight)));
  const lastRow = Math.min(totalRows, Math.max(firstRow, Math.ceil((scrollTop + viewport) / rowHeight)));
  const startRow = Math.max(0, firstRow - overscan);
  const endRow = Math.min(totalRows, lastRow + overscan);
  return {
    start: startRow * columns,
    end: Math.min(count, endRow * columns),
    padTop: startRow * rowHeight,
    padBottom: (totalRows - endRow) * rowHeight,
  };
}
