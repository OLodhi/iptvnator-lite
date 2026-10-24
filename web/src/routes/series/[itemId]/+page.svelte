<script lang="ts">
  import { page } from '$app/state';
  import type { CatalogItem, Season } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';

  let itemId = $derived(page.params.itemId ?? '');
  let item = $state<CatalogItem | null>(null);
  let seasons = $state<Season[]>([]);
  let loading = $state(true);
  let error = $state('');

  $effect(() => {
    const id = itemId;
    let cancelled = false;
    loading = true;
    error = '';
    (async () => {
      try {
        const [i, s] = await Promise.all([
          api<CatalogItem>(`/api/items/${encodeURIComponent(id)}`),
          api<Season[]>(`/api/items/${encodeURIComponent(id)}/seasons`)
        ]);
        if (cancelled) return;
        item = i;
        seasons = s;
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

<p><a href="/browse/series">‹ Back</a></p>
<h1>{item?.name ?? 'Series'}</h1>

{#if loading}
  <p class="muted">Loading…</p>
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else if seasons.length === 0}
  <p class="muted">No episodes yet.</p>
{:else}
  {#each seasons as s (s.season)}
    <h2>Season {s.season}</h2>
    <ul class="list">
      {#each s.episodes as ep (ep.remoteId)}
        <li>
          <a class="row" href={`/watch?item=${itemId}&episode=${encodeURIComponent(ep.remoteId)}`}>
            <span>{ep.episodeNum}. {ep.title}</span>
            {#if ep.durationSec}<span class="count">{Math.round(ep.durationSec / 60)} min</span>{/if}
          </a>
        </li>
      {/each}
    </ul>
  {/each}
{/if}
