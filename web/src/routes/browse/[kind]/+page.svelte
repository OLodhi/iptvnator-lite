<script lang="ts">
  import { page } from '$app/state';
  import type { BrowseCategory, BrowseView, CatalogItem, Kind } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { browse, hideCategory, pin, unpin } from '$lib/me';
  import { browseSections, newCategoriesBanner } from '$lib/browseModel';
  import { rememberCategories } from '$lib/categoryNames';
  import { longpress } from '$lib/actions/longpress';
  import ActionSheet from '$lib/components/ActionSheet.svelte';
  import Artwork from '$lib/components/Artwork.svelte';
  import Carousel from '$lib/components/Carousel.svelte';
  import PosterCell from '$lib/components/PosterCell.svelte';

  const titles: Record<Kind, string> = { live: 'Live', movie: 'Movies', series: 'Series' };

  let kind = $derived((page.params.kind ?? 'live') as Kind);
  let view = $state<BrowseView | null>(null);
  let loading = $state(true);
  let error = $state('');
  let sheetFor = $state<BrowseCategory | null>(null);
  let seq = 0;

  const sections = $derived(view ? browseSections(view) : []);
  const banner = $derived(view ? newCategoriesBanner(view) : null);

  async function load(k: Kind, quiet: boolean) {
    const mine = ++seq;
    if (!quiet) {
      loading = true;
      view = null;
    }
    error = '';
    try {
      const result = await browse(k);
      if (mine === seq) {
        view = result;
        rememberCategories(result);
      }
    } catch (err) {
      if (mine === seq) error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    } finally {
      if (mine === seq) loading = false;
    }
  }

  $effect(() => {
    void load(kind, false);
    return () => {
      seq++;
    };
  });

  const itemHref = (item: CatalogItem, episode?: string | null) =>
    item.kind === 'series' && !episode
      ? `/series/${item.id}`
      : `/watch?item=${item.id}${episode ? `&episode=${encodeURIComponent(episode)}` : ''}`;

  async function act(run: () => Promise<void>) {
    let failure = '';
    try {
      await run();
    } catch (err) {
      failure = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    }
    await load(kind, true); // clears `error`, so report the failure afterwards
    if (failure) error = failure;
  }

  // The sheet clears `sheetFor` before running an action, so each action captures its own target.
  const sheetActions = $derived.by(() => {
    const target = sheetFor;
    if (!target) return [];
    return [
      target.pinned
        ? { label: 'Unpin', run: () => void act(() => unpin(target.id)) }
        : { label: 'Pin', run: () => void act(() => pin(target.id)) },
      { label: 'Hide', danger: true, run: () => void act(() => hideCategory(target.id)) },
    ];
  });
</script>

<h1>{titles[kind] ?? 'Browse'}</h1>

<a class="searchbox" href="/search" aria-label="Search">
  <span aria-hidden="true">⌕</span> Search channels, movies, series
</a>

{#if banner}
  <a class="banner" href={banner.href}>{banner.text}<span aria-hidden="true">›</span></a>
{/if}

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

{#if loading}
  <div class="skeleton" aria-busy="true" aria-label="Loading">
    <div class="sk-title"></div>
    <div class="sk-strip">{#each [1, 2, 3, 4] as n (n)}<div class="sk-card"></div>{/each}</div>
    {#each [1, 2, 3, 4, 5] as n (n)}<div class="sk-row"></div>{/each}
  </div>
{:else if view && view.providerId === null}
  <p>No provider yet. <a href="/settings/providers">Add one</a>.</p>
{:else if view && sections.length === 0}
  <div class="empty">
    <p>Nothing to show here yet.</p>
    <p class="muted">Every category is hidden or the library is empty.</p>
    <a class="button" href={`/settings/categories?kind=${kind}`}>Choose categories</a>
  </div>
{:else if view}
  {#each sections as s (s.key)}
    {#if s.kind === 'items'}
      {@const items = s.key === 'recent' ? view.recent : view.favourites}
      <Carousel title={s.title}>
        {#each items as item (item.id)}
          {#if item.kind === 'live'}
            <a class="chan" href={itemHref(item)}>
              <span class="chan-logo"><Artwork name={item.displayName} src={item.logoUrl} fit="contain" /></span>
              <span class="chan-name">{item.displayName}</span>
            </a>
          {:else}
            <div class="poster-slot"><PosterCell {item} href={itemHref(item)} /></div>
          {/if}
        {/each}
      </Carousel>
    {:else if s.kind === 'continue'}
      <Carousel title={s.title}>
        {#each view.continueWatching as c (`${c.item.id}:${c.episodeRemoteId ?? ''}`)}
          <div class="poster-slot">
            <PosterCell
              item={c.item}
              href={itemHref(c.item, c.episodeRemoteId)}
              sub={c.episodeLabel}
              progress={c.durationSec ? c.positionSec / c.durationSec : null}
            />
          </div>
        {/each}
      </Carousel>
    {:else}
      {@const cats = s.key === 'pinned' ? view.pinned : view.categories}
      <h2>{s.title}</h2>
      <ul class="list">
        {#each cats as c (c.id)}
          <li>
            <a
              class="row pressable"
              href={`/browse/${kind}/${c.id}`}
              use:longpress={{ onLongPress: () => (sheetFor = c) }}
            >
              <span class="cat-name">{#if c.pinned && s.key === 'all'}<span class="pin" aria-label="Pinned">●</span>{/if}{c.displayName}</span>
              <span class="count">{c.itemCount} <span aria-hidden="true">›</span></span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
  <p class="hint muted">Press and hold a category to pin or hide it.</p>
{/if}

<ActionSheet
  open={sheetFor !== null}
  title={sheetFor?.displayName ?? ''}
  actions={sheetActions}
  onClose={() => (sheetFor = null)}
/>

<style>
  .searchbox {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--row-height);
    padding: 0 14px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
    text-decoration: none;
  }
  .banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: var(--row-height);
    margin-top: 12px;
    padding: 0 16px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--accent) 18%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--text);
    font-weight: 600;
    text-decoration: none;
  }
  .row {
    min-height: 56px;
  }
  .cat-name {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .pin {
    color: var(--accent);
    font-size: 0.6rem;
    margin-right: 8px;
    vertical-align: middle;
  }
  .chan {
    width: 92px;
    display: grid;
    gap: 6px;
    justify-items: center;
    text-decoration: none;
    color: var(--text);
    padding: 4px 0;
  }
  .chan-logo {
    width: 76px;
    height: 76px;
    border-radius: 14px;
    overflow: hidden;
    background: var(--surface);
  }
  .chan-name {
    width: 100%;
    text-align: center;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .poster-slot {
    width: 124px;
    height: 238px;
  }
  .hint {
    text-align: center;
    font-size: 0.85rem;
    margin-top: 20px;
  }
  .empty {
    display: grid;
    gap: 4px;
    justify-items: center;
    text-align: center;
    padding: 40px 0;
  }
  .skeleton {
    margin-top: 20px;
    display: grid;
    gap: 10px;
  }
  .sk-title,
  .sk-card,
  .sk-row {
    border-radius: 12px;
    background: linear-gradient(90deg, var(--surface) 25%, var(--surface-2) 50%, var(--surface) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }
  .sk-title {
    width: 40%;
    height: 20px;
  }
  .sk-strip {
    display: flex;
    gap: 10px;
    overflow: hidden;
  }
  .sk-card {
    flex: none;
    width: 112px;
    height: 168px;
  }
  .sk-row {
    height: 56px;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sk-title,
    .sk-card,
    .sk-row {
      animation: none;
    }
  }
</style>
