<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { CatalogItem, GridRow, GuideMeta, Programme } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { grid, programmes } from '$lib/guide';
  import { formatClock, sharedClock } from '$lib/guide/time';
  import { CHANNEL_COL, PAGE_SEC, ROW_HEIGHT, SLOT_MIN, initialWindow, layoutProgrammes, offsetPx, type Block } from '$lib/guide/layout';
  import Artwork from '$lib/components/Artwork.svelte';
  import VirtualList from '$lib/components/VirtualList.svelte';

  type Props = { meta: GuideMeta; filter: string; /** IANA zone; the app leaves it unset to use the device zone. */ tz?: string };
  let { meta, filter, tz }: Props = $props();

  type Side = 'left' | 'right';
  const DAY = 86_400;
  const SLOT_SEC = SLOT_MIN * 60;
  /** The server's limit on items per programmes request. */
  const MAX_ITEMS = 200;
  /** Blocks narrower than this show no text. */
  const TEXT_MIN_PX = 40;
  /** Space between neighbouring blocks. */
  const GAP_PX = 2;
  const clock = sharedClock();

  let rows = $state.raw<GridRow[]>([]);
  let windowFrom = $state(0);
  let windowTo = $state(0);
  let loading = $state(true);
  let error = $state('');
  let scrollX = $state(0);
  let scroller: HTMLDivElement | undefined = $state();
  let nextCursor: string | null = null;
  /** The opening window. Every row page is fetched for it; the rest of the loaded window is filled in after. */
  let core = { from: 0, to: 0 };
  let positioned = false;
  let pending = new Set<Side | 'more'>();
  let seq = 0;
  let controller: AbortController | undefined;
  let queue: Promise<void> = Promise.resolve();

  const nowSec = $derived(Math.floor(clock.nowMs / 1000));
  const width = $derived(CHANNEL_COL + offsetPx(windowTo, windowFrom));
  const nowLeft = $derived(windowFrom <= nowSec && nowSec < windowTo ? CHANNEL_COL + offsetPx(nowSec, windowFrom) : null);
  const ticks = $derived.by(() => {
    const out: number[] = [];
    for (let t = Math.ceil(windowFrom / SLOT_SEC) * SLOT_SEC; t < windowTo; t += SLOT_SEC) out.push(t);
    return out;
  });
  const chipLabel = $derived(meta.chips.find((c) => c.filter === filter)?.label ?? 'All');

  const errorText = (err: unknown) => (err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.');
  const guidedIds = (list: GridRow[]) => list.filter((r) => r.hasGuide).map((r) => r.item.id);

  // One request at a time, in order: a row page and a sideways extension both read and grow the loaded data.
  function enqueue(mine: number, op: () => Promise<void>) {
    queue = queue.then(() => (mine === seq ? op() : undefined));
  }

  /** Programmes for `ids` over `spans`, in requests the server accepts: at most 200 items and 24 h each. */
  async function fetchProgrammes(ids: number[], spans: [number, number][], signal: AbortSignal): Promise<Map<number, Programme[]>> {
    const requests: Promise<Record<string, Programme[]>>[] = [];
    for (const [from, to] of spans)
      for (let start = from; start < to; start += DAY)
        for (let i = 0; i < ids.length; i += MAX_ITEMS) requests.push(programmes(ids.slice(i, i + MAX_ITEMS), start, Math.min(to, start + DAY), signal));
    const out = new Map<number, Programme[]>();
    for (const found of await Promise.all(requests))
      for (const [id, list] of Object.entries(found)) out.set(Number(id), [...(out.get(Number(id)) ?? []), ...list]);
    return out;
  }

  /** The row with `extra` merged in, in start order. A programme spanning two fetches comes back from both, so ids de-duplicate. */
  function merged(row: GridRow, extra: Programme[] | undefined): GridRow {
    if (!extra?.length) return row;
    const byId = new Map(row.programmes.map((p) => [p.id, p]));
    for (const p of extra) byId.set(p.id, p);
    return { ...row, programmes: [...byId.values()].sort((a, b) => a.startSec - b.startSec) };
  }

  function setScroll(x: number) {
    if (!scroller) return;
    scroller.scrollLeft = x;
    scrollX = scroller.scrollLeft;
  }

  async function loadRows(mine: number, cursor: string | null) {
    loading = true;
    error = '';
    try {
      const signal = controller!.signal;
      const page = await grid({ filter, from: core.from, to: core.to, cursor }, signal);
      // The window may have grown sideways since the opening: fill in the new rows' outer spans.
      const extra = await fetchProgrammes(guidedIds(page.items), [[windowFrom, core.from], [core.to, windowTo]], signal);
      if (mine !== seq) return;
      const fresh = page.items.map((r) => merged(r, extra.get(r.item.id)));
      rows = cursor ? [...rows, ...fresh] : fresh;
      nextCursor = page.nextCursor;
    } catch (err) {
      if (mine === seq) error = errorText(err);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  async function extend(mine: number, side: Side) {
    const range = meta.range;
    if (!range) return;
    const from = side === 'left' ? Math.max(range.fromSec, windowFrom - PAGE_SEC) : windowTo;
    const to = side === 'left' ? windowFrom : Math.min(range.toSec, windowTo + PAGE_SEC);
    if (from >= to) return;
    try {
      const found = await fetchProgrammes(guidedIds(rows), [[from, to]], controller!.signal);
      if (mine !== seq) return;
      rows = rows.map((r) => merged(r, found.get(r.item.id)));
      error = '';
      if (side === 'right') windowTo = to;
      else {
        windowFrom = from;
        await tick();
        // The content grew on the left: scroll on by as much so the view stays put.
        if (mine === seq && scroller) setScroll(scroller.scrollLeft + offsetPx(to, from));
      }
    } catch (err) {
      if (mine === seq) error = errorText(err);
    }
  }

  function request(side: Side) {
    const range = meta.range;
    if (!range || pending.has(side) || (side === 'left' ? windowFrom <= range.fromSec : windowTo >= range.toSec)) return;
    pending.add(side);
    const mine = seq;
    enqueue(mine, async () => {
      await extend(mine, side);
      if (mine === seq) pending.delete(side);
    });
  }

  // Within one screen of either end, the window grows by a page, as far as the guide goes.
  function onScroll() {
    if (!scroller) return;
    scrollX = scroller.scrollLeft;
    if (rows.length === 0 || error) return;
    const { scrollLeft, scrollWidth, clientWidth } = scroller;
    if (scrollWidth - scrollLeft - clientWidth < clientWidth) request('right');
    if (scrollLeft < clientWidth) request('left');
  }

  function more() {
    if (!nextCursor || pending.has('more')) return;
    pending.add('more');
    const mine = seq;
    enqueue(mine, async () => {
      await loadRows(mine, nextCursor);
      if (mine === seq) pending.delete('more');
    });
  }

  // Starts again from page 1 at the opening window; responses for the old list are discarded by the token.
  function reload() {
    const mine = ++seq;
    controller?.abort();
    controller = new AbortController();
    queue = Promise.resolve();
    pending = new Set();
    core = initialWindow(Math.floor(clock.nowMs / 1000));
    windowFrom = core.from;
    windowTo = core.to;
    rows = [];
    nextCursor = null;
    loading = true;
    error = '';
    positioned = false;
    setScroll(0);
    enqueue(mine, () => loadRows(mine, null));
  }

  $effect(() => {
    void filter;
    untrack(reload);
    return () => {
      seq++;
      controller?.abort();
    };
  });

  // Once the first rows are in, open with now − 30 min at the left edge, just right of the channel column.
  // `rows` and `scroller` are read before the plain `positioned` flag so the effect stays subscribed across reloads.
  $effect(() => {
    if (rows.length === 0 || !scroller || positioned) return;
    positioned = true;
    setScroll(offsetPx(Math.floor(untrack(() => clock.nowMs) / 1000) - 1800, windowFrom));
  });

  // The server's catch-up rule: a channel with catch-up days, and a programme that started within them.
  function hrefFor(item: CatalogItem, b: Block, now: number): string | null {
    if (b.state === 'now') return `/watch?item=${item.id}`;
    const days = item.catchupDays ?? 0;
    if (b.state !== 'past' || days <= 0 || b.programme.startSec < now - days * DAY) return null;
    const p = b.programme;
    return `/watch?item=${item.id}&from=${p.startSec}&to=${p.stopSec}&title=${encodeURIComponent(p.title)}`;
  }
</script>

<div class="guide-grid" data-testid="guide-grid" style:--channel-col="{CHANNEL_COL}px">
  {#if error}
    <p class="error" role="alert">{error} <button type="button" class="retry" onclick={reload}>Retry</button></p>
  {/if}
  {#if !loading && !error && rows.length === 0}
    <p class="empty">No channels in {chipLabel}</p>
  {/if}

  <!-- Outside the scroller, which would otherwise be its sticky container: it follows the scroll by transform. -->
  <div class="ruler" aria-hidden="true">
    <div class="ruler-track" style:width="{width}px" style:transform="translateX({-scrollX}px)">
      {#each ticks as t (t)}
        <span class="tick" style:left="{CHANNEL_COL + offsetPx(t, windowFrom)}px">{formatClock(t, tz)}</span>
      {/each}
      {#if nowLeft !== null}<span class="ruler-now" style:left="{nowLeft}px"></span>{/if}
    </div>
  </div>

  <div class="scroller" bind:this={scroller} onscroll={onScroll}>
    <div class="content" style:width="{width}px">
      <VirtualList items={rows} rowHeight={ROW_HEIGHT} onEnd={more}>
        {#snippet row(r: GridRow)}
          <div class="lane-row">
            <a class="channel" href={`/watch?item=${r.item.id}`} draggable="false" aria-label={`Watch ${r.item.displayName} live`}>
              <span class="logo"><Artwork name={r.item.displayName} src={r.item.logoUrl} fit="contain" /></span>
              <span class="name">{r.item.displayName}</span>
            </a>
            <div class="lane" class:unguided={!r.hasGuide}>
              {#if !r.hasGuide}
                <span class="no-guide">No guide information</span>
              {:else}
                {#each layoutProgrammes(r.programmes, windowFrom, windowTo, nowSec) as b (b.programme.id)}
                  {@const href = hrefFor(r.item, b, nowSec)}
                  {@const catchup = href !== null && b.state === 'past'}
                  <svelte:element
                    this={href ? 'a' : 'div'}
                    class="block {b.state}"
                    {href}
                    draggable="false"
                    aria-label={href
                      ? `${catchup ? 'Catch up' : 'Watch live'}: ${b.programme.title}, ${formatClock(b.programme.startSec, tz)}–${formatClock(b.programme.stopSec, tz)}`
                      : undefined}
                    style:left="{b.left}px"
                    style:width="{Math.max(2, b.width - GAP_PX)}px"
                  >
                    {#if b.width >= TEXT_MIN_PX}
                      <span class="title">{#if catchup}<span class="cu">↺</span> {/if}{b.programme.title}</span>
                      <small>{formatClock(b.programme.startSec, tz)}</small>
                    {/if}
                  </svelte:element>
                {/each}
              {/if}
            </div>
          </div>
        {/snippet}
      </VirtualList>
      {#if nowLeft !== null}<div class="now-line" style:left="{nowLeft}px" aria-hidden="true"></div>{/if}
    </div>
  </div>
</div>

<style>
  .guide-grid {
    --now-line: #ff453a;
    margin: 0 -16px; /* edge to edge on a phone */
    isolation: isolate; /* keeps the layers below inside the grid, under the fixed tab bar */
  }
  .guide-grid > p {
    padding: 0 16px;
  }
  .retry {
    min-height: 44px;
    padding: 0 14px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .empty {
    text-align: center;
    color: var(--muted);
    padding: 32px 0;
  }

  .ruler {
    position: sticky;
    top: 0;
    z-index: 3;
    height: 28px;
    overflow: hidden;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .ruler-track {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    will-change: transform;
  }
  /* The corner above the channel column. */
  .ruler::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--channel-col);
    background: var(--bg);
  }
  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    padding: 6px 0 0 4px;
    border-left: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.72rem;
    white-space: nowrap;
  }
  .ruler-now {
    position: absolute;
    bottom: 0;
    width: 2px;
    height: 8px;
    margin-left: -1px;
    background: var(--now-line);
  }

  .scroller {
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .scroller::-webkit-scrollbar {
    display: none;
  }
  .content {
    position: relative;
  }
  /* VirtualList clips its rows; a clipping row would hold the sticky channel cell instead of the scroller. */
  .content .lane-row {
    overflow: visible;
  }
  .lane-row {
    display: flex;
    height: 100%;
    border-bottom: 1px solid var(--border);
  }
  .channel {
    position: sticky;
    left: 0;
    z-index: 2;
    flex: none;
    width: var(--channel-col);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 0 4px;
    background: var(--bg);
    border-right: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
    -webkit-touch-callout: none;
  }
  .channel:active {
    background: var(--surface);
  }
  .logo {
    width: 48px;
    height: 28px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--surface);
  }
  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 0.65rem;
  }
  .lane {
    position: relative;
    flex: 1;
  }
  .lane.unguided {
    background: color-mix(in srgb, var(--surface) 50%, transparent);
  }
  .no-guide {
    position: sticky;
    left: calc(var(--channel-col) + 8px);
    display: inline-flex;
    align-items: center;
    height: 100%;
    padding: 0 8px;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .block {
    position: absolute;
    top: 4px;
    bottom: 4px;
    padding: 5px 6px;
    overflow: hidden;
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    font-size: 0.8rem;
    line-height: 1.25;
    -webkit-touch-callout: none;
  }
  .block.past {
    background: color-mix(in srgb, var(--surface) 55%, var(--bg));
    color: var(--muted);
  }
  .block.now {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border-left: 2px solid var(--accent);
  }
  a.block:active {
    filter: brightness(1.3);
  }
  .title,
  .block small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-weight: 600;
  }
  .block small {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .cu {
    color: #ff9f43;
  }
  .now-line {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    width: 2px;
    margin-left: -1px;
    background: var(--now-line);
    pointer-events: none;
  }
</style>
