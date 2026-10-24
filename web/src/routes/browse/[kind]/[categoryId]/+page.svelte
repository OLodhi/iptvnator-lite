<script lang="ts">
  import { page } from '$app/state';
  import type { CatalogItem, Page } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';

  let kind = $derived(page.params.kind ?? 'live');
  let categoryId = $derived(page.params.categoryId ?? '');
  let items = $state<CatalogItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let error = $state('');

  async function load(id: string, cursor: string | null) {
    loading = true;
    error = '';
    try {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await api<Page<CatalogItem>>(`/api/categories/${encodeURIComponent(id)}/items${qs}`);
      if (id !== categoryId) return;
      items = cursor ? [...items, ...res.items] : res.items;
      nextCursor = res.nextCursor;
    } catch (err) {
      error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    items = [];
    nextCursor = null;
    void load(categoryId, null);
  });

  const hrefFor = (item: CatalogItem) => (item.kind === 'series' ? `/series/${item.id}` : `/watch?item=${item.id}`);
</script>

<p><a href={`/browse/${kind}`}>‹ Back</a></p>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

{#if items.length > 0}
  <ul class="list">
    {#each items as item (item.id)}
      <li>
        <a class="row" href={hrefFor(item)}>
          <span>{item.name}</span>
          {#if item.year}<span class="count">{item.year}</span>{/if}
        </a>
      </li>
    {/each}
  </ul>
{:else if !loading && !error}
  <p class="muted">Nothing in this category.</p>
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else if nextCursor}
  <button class="primary more" onclick={() => load(categoryId, nextCursor)}>Load more</button>
{/if}
