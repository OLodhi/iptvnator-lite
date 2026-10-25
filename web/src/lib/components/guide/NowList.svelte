<script lang="ts">
  import { untrack } from 'svelte';
  import type { CatalogItem, GridRow, Page } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { grid } from '$lib/guide';
  import { formatClock, progress, sharedClock } from '$lib/guide/time';
  import VirtualList from '$lib/components/VirtualList.svelte';
  import WhatsOnRow from './WhatsOnRow.svelte';

  type Props = {
    filter: string;
    /** What the filter shows, for the empty text: the category's name, or Favourites. */
    label: string;
    /** A press held on a row. */
    onLongPress?: (item: CatalogItem) => void;
    /** IANA zone; the app leaves it unset to use the device zone. */
    tz?: string;
  };
  let { filter, label, onLongPress, tz }: Props = $props();

  const clock = sharedClock();
  // The grid route's default page size, and its largest.
  const PAGE = 30;
  const MAX_PAGE = 100;
  /** Each page asks about the coming minute, so a programme that starts in it is there when the clock gets to it. */
  const WINDOW_SEC = 60;

  // Raw, as in the grid: pages replace the rows whole.
  let rows = $state.raw<GridRow[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let error = $state('');
  let seq = 0;
  let refreshing = false; // a quiet refresh is in flight; paging waits for its swap
  let controller: AbortController | undefined;

  /** A page of the filter's channels, in order, each with its programmes in the coming minute. */
  function fetchPage(cursor: string | null, limit?: number): Promise<Page<GridRow>> {
    const now = Math.floor(clock.nowMs / 1000);
    return grid({ filter, from: now, to: now + WINDOW_SEC, cursor, limit }, controller?.signal);
  }

  async function load(mine: number, cursor: string | null) {
    loading = true;
    error = '';
    try {
      const page = await fetchPage(cursor);
      if (mine !== seq) return;
      rows = cursor ? [...rows, ...page.items] : page.items;
      nextCursor = page.nextCursor;
    } catch (err) {
      if (mine === seq) error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    } finally {
      if (mine === seq) loading = false;
    }
  }

  // Re-fetches as many rows as are loaded, from the start, then swaps them in at once: the list never
  // shrinks, so a scrolled reader stays put. A failure keeps the current rows.
  async function refresh(mine: number) {
    const want = rows.length;
    const items: GridRow[] = [];
    let cursor: string | null = null;
    refreshing = true;
    try {
      do {
        const page: Page<GridRow> = await fetchPage(cursor, Math.min(MAX_PAGE, Math.max(PAGE, want - items.length)));
        if (mine !== seq) return;
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && items.length < want);
      rows = items;
      nextCursor = cursor;
      error = '';
    } catch {
      // Quiet: the rows on screen stay.
    } finally {
      if (mine === seq) {
        refreshing = false;
        loading = false;
      }
    }
  }

  // A full reload starts the list again from page 1; a quiet one refreshes the loaded rows in place.
  function reload(quiet: boolean) {
    const mine = ++seq;
    refreshing = false;
    controller?.abort();
    controller = new AbortController();
    if (!quiet) {
      rows = [];
      nextCursor = null;
    }
    void (quiet ? refresh(mine) : load(mine, null));
  }

  // A new filter or zone starts a fresh list; responses for the old one are discarded by the token.
  $effect(() => {
    void filter;
    void tz;
    untrack(() => reload(false));
    return () => {
      seq++;
      controller?.abort();
    };
  });

  // What's on changes: refresh every minute while the app is on screen, and when it comes back to the foreground.
  $effect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload(true);
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  function more() {
    if (!nextCursor || loading || refreshing) return;
    void load(seq, nextCursor);
  }

  // The rows follow the shared clock, so one whose programme ends moves on to the next without a request.
  const nowSec = $derived(Math.floor(clock.nowMs / 1000));
  const emptyText = $derived(`Nothing on${label ? ` in ${label}` : ''} right now`);
</script>

{#if error}
  <p class="error" role="alert">{error} <button type="button" class="retry" onclick={() => reload(false)}>Retry</button></p>
{/if}

{#if !loading && !error && rows.length === 0}
  <p class="empty">{emptyText}</p>
{/if}

<VirtualList items={rows} rowHeight={68} onEnd={more}>
  {#snippet row(r: GridRow)}
    {@const on = r.programmes.find((p) => p.startSec <= nowSec && nowSec < p.stopSec)}
    <WhatsOnRow
      item={r.item}
      href={`/watch?item=${r.item.id}`}
      title={r.item.displayName}
      sub={on ? `${on.title} · until ${formatClock(on.stopSec, tz)}` : r.hasGuide ? 'Nothing on now' : 'No guide information'}
      progress={on ? progress(on.startSec, on.stopSec, clock.nowMs) : null}
      action="play"
      {onLongPress}
    />
  {/snippet}
</VirtualList>

<style>
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
</style>
