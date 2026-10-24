<script lang="ts">
  import { page } from '$app/state';
  import type { Category } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { firstProvider } from '$lib/provider';

  const titles: Record<string, string> = { live: 'Live', movie: 'Movies', series: 'Series' };

  let kind = $derived(page.params.kind ?? 'live');
  let categories = $state<Category[]>([]);
  let loading = $state(true);
  let noProvider = $state(false);
  let error = $state('');

  $effect(() => {
    const k = kind;
    let cancelled = false;
    loading = true;
    error = '';
    noProvider = false;
    categories = [];
    (async () => {
      try {
        const provider = await firstProvider();
        if (cancelled) return;
        if (!provider) {
          noProvider = true;
          return;
        }
        const result = await api<Category[]>(`/api/providers/${provider.id}/categories?kind=${encodeURIComponent(k)}`);
        if (!cancelled) categories = result;
      } catch (err) {
        if (!cancelled) error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

<h1>{titles[kind] ?? 'Browse'}</h1>

{#if loading}
  <p class="muted">Loading…</p>
{:else if noProvider}
  <p>No provider yet. <a href="/settings/providers">Add one</a>.</p>
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else if categories.length === 0}
  <p class="muted">Nothing here yet.</p>
{:else}
  <ul class="list">
    {#each categories as c (c.id)}
      <li>
        <a class="row" href={`/browse/${kind}/${c.id}`}><span>{c.name}</span><span class="count">{c.itemCount}</span></a>
      </li>
    {/each}
  </ul>
{/if}
