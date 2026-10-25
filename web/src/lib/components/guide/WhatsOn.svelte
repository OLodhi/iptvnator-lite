<script lang="ts">
  import { untrack } from 'svelte';
  import type { CatalogItem, Page, WhatsOnEntry } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { whatsOn } from '$lib/guide';
  import { formatClock, progress, segmentQuery, sharedClock, type Segment, type SegmentQuery } from '$lib/guide/time';
  import VirtualList from '$lib/components/VirtualList.svelte';
  import WhatsOnRow from './WhatsOnRow.svelte';

  type Props = {
    filter: string;
    /** What the filter shows, for the empty texts: the category's name, or Favourites. */
    label: string;
    /** A press held on a row. */
    onLongPress?: (item: CatalogItem) => void;
    /** IANA zone; the app leaves it unset to use the device zone. */
    tz?: string;
  };
  let { filter, label, onLongPress, tz }: Props = $props();

  const segments: { key: Segment; label: string }[] = [
    { key: 'earlier', label: 'Earlier' },
    { key: 'now', label: 'Now' },
    { key: 'tonight', label: 'Tonight' },
    { key: 'tomorrow', label: 'Tomorrow' },
  ];
  const clock = sharedClock();
  // The route's default page size, and its largest.
  const PAGE = 50;
  const MAX_PAGE = 200;

  let segment = $state<Segment>('now');
  let entries = $state<WhatsOnEntry[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let error = $state('');
  let noWindow = $state(false);
  let query: SegmentQuery | null = null;
  let seq = 0;
  let refreshing = false; // a quiet refresh is in flight; paging waits for its swap
  let controller: AbortController | undefined;

  async function load(mine: number, cursor: string | null) {
    if (!query) return;
    loading = true;
    error = '';
    try {
      const page = await whatsOn({ filter, ...query, cursor }, controller?.signal);
      if (mine !== seq) return;
      entries = cursor ? [...entries, ...page.items] : page.items;
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
    if (!query) return;
    const params = { filter, ...query };
    const want = entries.length;
    const items: WhatsOnEntry[] = [];
    let cursor: string | null = null;
    refreshing = true;
    try {
      do {
        const limit = Math.min(MAX_PAGE, Math.max(PAGE, want - items.length));
        const page: Page<WhatsOnEntry> = await whatsOn({ ...params, cursor, limit }, controller?.signal);
        if (mine !== seq) return;
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && items.length < want);
      entries = items;
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
      entries = [];
      nextCursor = null;
    }
    query = segmentQuery(segment, clock.nowMs, tz);
    noWindow = query === null;
    if (noWindow) {
      entries = [];
      nextCursor = null;
      loading = false;
      error = '';
      return;
    }
    void (quiet ? refresh(mine) : load(mine, null));
  }

  // A new segment, filter or zone starts a fresh list; responses for the old one are discarded by the token.
  $effect(() => {
    void segment;
    void filter;
    void tz;
    untrack(() => reload(false));
    return () => {
      seq++;
      controller?.abort();
    };
  });

  // The Now list goes stale: refresh it every minute while the app is on screen, and when it comes back to the foreground.
  $effect(() => {
    if (segment !== 'now') return;
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

  // Until the page knows its category's name, the texts go without it.
  const where = $derived(label ? ` in ${label}` : '');
  const emptyText = $derived(
    segment === 'tonight' || segment === 'tomorrow' ? `Nothing on${where} ${segment === 'tonight' ? 'tonight' : 'tomorrow'}` : segment === 'earlier' ? `Nothing earlier${where}` : `Nothing on${where} right now`,
  );

  const hrefFor = (e: WhatsOnEntry): string | null =>
    e.live
      ? `/watch?item=${e.item.id}`
      : e.catchup
        ? `/watch?item=${e.item.id}&from=${e.programme.startSec}&to=${e.programme.stopSec}&title=${encodeURIComponent(e.programme.title)}`
        : null;
</script>

<div class="segments" role="group" aria-label="When">
  {#each segments as s (s.key)}
    <button type="button" aria-pressed={segment === s.key} class:on={segment === s.key} onclick={() => (segment = s.key)}>{s.label}</button>
  {/each}
</div>

{#if error}
  <p class="error" role="alert">{error} <button type="button" class="retry" onclick={() => reload(false)}>Retry</button></p>
{/if}

{#if noWindow}
  <p class="empty">Nothing more tonight</p>
{:else if !loading && !error && entries.length === 0}
  <p class="empty">{emptyText}</p>
{/if}

<VirtualList items={entries} rowHeight={68} onEnd={more}>
  {#snippet row(e: WhatsOnEntry)}
    <WhatsOnRow
      item={e.item}
      href={hrefFor(e)}
      title={e.programme.title}
      sub={`${e.item.displayName} · ${e.live ? `until ${formatClock(e.programme.stopSec, tz)}` : `${formatClock(e.programme.startSec, tz)}–${formatClock(e.programme.stopSec, tz)}`}`}
      progress={e.live ? progress(e.programme.startSec, e.programme.stopSec, clock.nowMs) : null}
      action={e.live ? 'play' : e.catchup ? 'catchup' : null}
      {onLongPress}
    />
  {/snippet}
</VirtualList>

<style>
  .segments {
    display: flex;
    padding: 3px;
    gap: 2px;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .segments button {
    flex: 1;
    min-height: 44px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    touch-action: manipulation;
  }
  .segments button.on {
    background: var(--surface-2);
    color: var(--text);
    font-weight: 600;
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
</style>
