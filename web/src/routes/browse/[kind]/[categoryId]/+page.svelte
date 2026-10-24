<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import type { CatalogItem, Kind, Page } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { favourite, unfavourite } from '$lib/me';
  import { posterRowHeight } from '$lib/browseModel';
  import ActionSheet from '$lib/components/ActionSheet.svelte';
  import ChannelRow from '$lib/components/ChannelRow.svelte';
  import PosterCell from '$lib/components/PosterCell.svelte';
  import VirtualList from '$lib/components/VirtualList.svelte';

  let kind = $derived((page.params.kind ?? 'live') as Kind);
  let categoryId = $derived(page.params.categoryId ?? '');
  let items = $state<CatalogItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let error = $state('');
  let gridWidth = $state(0);
  let sheetFor = $state<CatalogItem | null>(null);

  const posterHeight = $derived(posterRowHeight(gridWidth || 360));

  async function load(id: string, cursor: string | null) {
    if (loading && cursor) return;
    loading = true;
    error = '';
    try {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await api<Page<CatalogItem>>(`/api/categories/${encodeURIComponent(id)}/items${qs}`);
      if (id !== categoryId) return;
      items = cursor ? [...items, ...res.items] : res.items;
      nextCursor = res.nextCursor;
    } catch (err) {
      if (id === categoryId) error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    } finally {
      if (id === categoryId) loading = false;
    }
  }

  $effect(() => {
    const id = categoryId;
    items = [];
    nextCursor = null;
    loading = false;
    untrack(() => void load(id, null));
  });

  function loadMore() {
    if (loading || !nextCursor) return;
    void load(categoryId, nextCursor);
  }

  async function toggleFavourite(item: CatalogItem) {
    const was = item.favourite;
    item.favourite = !was;
    try {
      await (was ? unfavourite(item.id) : favourite(item.id));
    } catch (err) {
      item.favourite = was;
      error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    }
  }

  const hrefFor = (item: CatalogItem) => (item.kind === 'series' ? `/series/${item.id}` : `/watch?item=${item.id}`);

  const sheetActions = $derived(
    sheetFor
      ? [
          {
            label: sheetFor.favourite ? 'Unfavourite' : 'Favourite',
            run: () => void toggleFavourite(sheetFor!),
          },
        ]
      : [],
  );
</script>

<p class="back"><a href={`/browse/${kind}`}>‹ Back</a></p>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

<div class="body" bind:clientWidth={gridWidth}>
  {#if items.length > 0}
    {#if kind === 'live'}
      <VirtualList {items} rowHeight={64} onEnd={loadMore}>
        {#snippet row(item)}
          <ChannelRow {item} onToggleFavourite={toggleFavourite} />
        {/snippet}
      </VirtualList>
    {:else}
      <VirtualList {items} rowHeight={posterHeight} columns={3} onEnd={loadMore}>
        {#snippet row(item)}
          <PosterCell {item} href={hrefFor(item)} onLongPress={(i) => (sheetFor = i)} />
        {/snippet}
      </VirtualList>
    {/if}
  {:else if loading}
    <div class="skeleton" aria-busy="true" aria-label="Loading">
      {#each [1, 2, 3, 4, 5, 6, 7] as n (n)}<div class="sk-row"></div>{/each}
    </div>
  {:else if !error}
    <p class="muted">Nothing in this category.</p>
  {/if}
</div>

{#if loading && items.length > 0}
  <p class="muted more-hint">Loading more…</p>
{/if}

<ActionSheet
  open={sheetFor !== null}
  title={sheetFor?.displayName ?? ''}
  actions={sheetActions}
  onClose={() => (sheetFor = null)}
/>

<style>
  .back {
    margin: 0 0 8px;
  }
  .back a {
    display: inline-flex;
    align-items: center;
    min-height: var(--row-height);
    text-decoration: none;
  }
  .more-hint {
    text-align: center;
  }
  .skeleton {
    display: grid;
  }
  .sk-row {
    height: 56px;
    margin: 4px 0;
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
