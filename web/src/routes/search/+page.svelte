<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { replaceState } from '$app/navigation';
  import type { CatalogItem } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { favourite, search, unfavourite } from '$lib/me';
  import { createSearchModel } from '$lib/searchModel';
  import { rememberCategoryName } from '$lib/categoryNames';
  import Carousel from '$lib/components/Carousel.svelte';
  import ChannelRow from '$lib/components/ChannelRow.svelte';
  import PosterCell from '$lib/components/PosterCell.svelte';

  const model = createSearchModel({ search: (q, signal) => search(q, 20, signal) });
  let input: HTMLInputElement | undefined = $state();
  let favOverride = $state<Record<number, boolean>>({});
  let actionError = $state('');

  const trimmed = $derived($model.query.trim());
  const results = $derived($model.results);
  const total = $derived(
    results ? results.live.length + results.movie.length + results.series.length + results.categories.length : 0,
  );

  onMount(() => {
    const q = page.url.searchParams.get('q') ?? '';
    if (q) model.setQuery(q);
    input?.focus(); // iOS may ignore this outside a user gesture; acceptable
    return () => model.destroy();
  });

  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    const q = e.currentTarget.value;
    model.setQuery(q);
    const url = new URL(page.url);
    if (q.trim()) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    replaceState(url, page.state);
  }

  const withFav = (item: CatalogItem): CatalogItem => ({ ...item, favourite: favOverride[item.id] ?? item.favourite });

  async function toggleFavourite(item: CatalogItem) {
    const was = item.favourite;
    favOverride[item.id] = !was;
    try {
      await (was ? unfavourite(item.id) : favourite(item.id));
    } catch (err) {
      favOverride[item.id] = was;
      actionError = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    }
  }

  const hrefFor = (item: CatalogItem) => (item.kind === 'series' ? `/series/${item.id}` : `/watch?item=${item.id}`);
</script>

<h1>Search</h1>

<form class="box" role="search" onsubmit={(e) => { e.preventDefault(); input?.blur(); }}>
  <input
    bind:this={input}
    type="search"
    inputmode="search"
    enterkeyhint="search"
    placeholder="Channels, movies, series, categories"
    aria-label="Search"
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    value={$model.query}
    oninput={onInput}
  />
</form>

{#if actionError}
  <p class="error" role="alert">{actionError}</p>
{/if}

{#if trimmed === ''}
  <p class="muted hint">Type to search channels, movies, series and categories.</p>
{:else if $model.error}
  <div class="state">
    <p class="error" role="alert">{$model.error}</p>
    <button type="button" class="primary" onclick={() => model.retry()}>Retry</button>
  </div>
{:else if results === null || ($model.loading && total === 0)}
  <div class="skeleton" aria-busy="true" aria-label="Searching">
    {#each [1, 2, 3, 4, 5] as n (n)}<div class="sk-row"></div>{/each}
  </div>
{:else if total === 0}
  <p class="muted hint">No matches for “{trimmed}”</p>
{:else}
  <div class="results" class:stale={$model.loading}>
    {#if results.live.length > 0}
      <h2>Channels</h2>
      <ul class="chan-list">
        {#each results.live as item (item.id)}
          <li><ChannelRow item={withFav(item)} onToggleFavourite={toggleFavourite} /></li>
        {/each}
      </ul>
    {/if}
    {#if results.movie.length > 0}
      <Carousel title="Movies">
        {#each results.movie as item (item.id)}
          <div class="poster-slot"><PosterCell item={withFav(item)} href={hrefFor(item)} /></div>
        {/each}
      </Carousel>
    {/if}
    {#if results.series.length > 0}
      <Carousel title="Series">
        {#each results.series as item (item.id)}
          <div class="poster-slot"><PosterCell item={withFav(item)} href={hrefFor(item)} /></div>
        {/each}
      </Carousel>
    {/if}
    {#if results.categories.length > 0}
      <h2>Categories</h2>
      <ul class="list">
        {#each results.categories as c (`${c.kind}:${c.id}`)}
          <li>
            <a class="row" href={`/browse/${c.kind}/${c.id}`} onclick={() => rememberCategoryName(c.id, c.displayName)}>
              <span class="cat-name">{c.displayName}</span>
              <span class="count">{c.itemCount} <span aria-hidden="true">›</span></span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .box input {
    width: 100%;
    min-height: var(--row-height);
    padding: 0 14px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 16px; /* below 16px iOS zooms the page on focus */
    appearance: none;
  }
  .box input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 0;
  }
  .hint {
    text-align: center;
    margin-top: 32px;
  }
  .state {
    display: grid;
    justify-items: center;
    gap: 8px;
    margin-top: 24px;
  }
  .results.stale {
    opacity: 0.6;
  }
  .chan-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .chan-list li {
    height: 64px;
  }
  .poster-slot {
    width: 124px;
    height: 238px;
  }
  .cat-name {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .skeleton {
    margin-top: 16px;
    display: grid;
    gap: 8px;
  }
  .sk-row {
    height: 56px;
    border-radius: 12px;
    background: linear-gradient(90deg, var(--surface) 25%, var(--surface-2) 50%, var(--surface) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sk-row {
      animation: none;
    }
  }
</style>
