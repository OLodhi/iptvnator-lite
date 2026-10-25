<script lang="ts">
  import { untrack } from 'svelte';
  import type { CatalogItem, WhatsOnEntry } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { whatsOn } from '$lib/guide';
  import { formatClock, progress, segmentQuery, sharedClock, type Segment, type SegmentQuery } from '$lib/guide/time';
  import { filterCategory, watchHref } from '$lib/watch/links';
  import VirtualList from '$lib/components/VirtualList.svelte';
  import NowList from './NowList.svelte';
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

  let segment = $state<Segment>('now');
  let entries = $state<WhatsOnEntry[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let error = $state('');
  let noWindow = $state(false);
  let query: SegmentQuery | null = null;
  let seq = 0;
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

  // Starts the segment's programmes again from page 1. Now is the channel list, which loads its own.
  function reload() {
    const mine = ++seq;
    controller?.abort();
    controller = new AbortController();
    entries = [];
    nextCursor = null;
    if (segment === 'now') return;
    query = segmentQuery(segment, clock.nowMs, tz);
    noWindow = query === null;
    if (noWindow) {
      loading = false;
      error = '';
      return;
    }
    void load(mine, null);
  }

  // A new segment, filter or zone starts a fresh list; responses for the old one are discarded by the token.
  $effect(() => {
    void segment;
    void filter;
    void tz;
    untrack(reload);
    return () => {
      seq++;
      controller?.abort();
    };
  });

  function more() {
    if (!nextCursor || loading) return;
    void load(seq, nextCursor);
  }

  // Until the page knows its category's name, the texts go without it.
  const where = $derived(label ? ` in ${label}` : '');
  const emptyText = $derived(segment === 'earlier' ? `Nothing earlier${where}` : `Nothing on${where} ${segment === 'tonight' ? 'tonight' : 'tomorrow'}`);

  // The watch page keeps the category, for its list and channel up and down.
  const category = $derived(filterCategory(filter));
  const hrefFor = (e: WhatsOnEntry): string | null =>
    e.live
      ? watchHref(e.item.id, { category })
      : e.catchup
        ? watchHref(e.item.id, { category, catchup: e.programme })
        : null;
</script>

<div class="segments" role="group" aria-label="When">
  {#each segments as s (s.key)}
    <button type="button" aria-pressed={segment === s.key} class:on={segment === s.key} onclick={() => (segment = s.key)}>{s.label}</button>
  {/each}
</div>

{#if segment === 'now'}
  <NowList {filter} {label} {onLongPress} {tz} />
{:else}
  {#if error}
    <p class="error" role="alert">{error} <button type="button" class="retry" onclick={reload}>Retry</button></p>
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
{/if}

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
