<script lang="ts">
  import { untrack } from 'svelte';
  import type { Page, WhatsOnEntry } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { whatsOn } from '$lib/guide';
  import { formatClock, progress, segmentQuery, sharedClock, type Segment, type SegmentQuery } from '$lib/guide/time';
  import Artwork from '$lib/components/Artwork.svelte';
  import VirtualList from '$lib/components/VirtualList.svelte';

  type Props = { filter: string; chipLabel: string; /** IANA zone; the app leaves it unset to use the device zone. */ tz?: string };
  let { filter, chipLabel, tz }: Props = $props();

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

  // A new segment, chip or zone starts a fresh list; responses for the old one are discarded by the token.
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

  const emptyText = $derived(
    segment === 'tonight' || segment === 'tomorrow' ? `Nothing on in ${chipLabel} ${segment === 'tonight' ? 'tonight' : 'tomorrow'}` : segment === 'earlier' ? `Nothing earlier in ${chipLabel}` : `Nothing on in ${chipLabel} right now`,
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
    {@const href = hrefFor(e)}
    {@const action = e.live ? 'play' : e.catchup ? 'catchup' : null}
    <svelte:element this={href ? 'a' : 'div'} class="entry" {href} draggable="false">
      <span class="thumb"><Artwork name={e.item.displayName} src={e.item.logoUrl} fit="contain" /></span>
      <span class="text">
        <span class="title">{e.programme.title}</span>
        <span class="sub">
          {e.item.displayName} · {e.live ? `until ${formatClock(e.programme.stopSec, tz)}` : `${formatClock(e.programme.startSec, tz)}–${formatClock(e.programme.stopSec, tz)}`}
        </span>
        {#if e.live}
          <span class="bar" aria-hidden="true"><span style:width="{Math.round(progress(e.programme.startSec, e.programme.stopSec, clock.nowMs) * 100)}%"></span></span>
        {/if}
      </span>
      {#if action === 'play'}
        <span class="action play" aria-label="Watch live">▶</span>
      {:else if action === 'catchup'}
        <span class="action catchup">↺ Catch up</span>
      {/if}
    </svelte:element>
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
  .entry {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 100%;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
  }
  a.entry:active {
    background: var(--surface);
  }
  .thumb {
    flex: none;
    width: 64px;
    height: 40px;
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .title,
  .sub {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-weight: 600;
  }
  .sub {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .bar {
    display: block;
    height: 2px;
    margin-top: 4px;
    border-radius: 1px;
    background: var(--border);
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .action {
    flex: none;
    padding-right: 4px;
    font-size: 0.85rem;
  }
  .play {
    font-size: 1.2rem;
  }
  .catchup {
    color: #ff9f43;
    font-weight: 600;
  }
</style>
