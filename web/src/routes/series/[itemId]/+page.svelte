<script lang="ts">
  import { page } from '$app/state';
  import type { CatalogItem, SavedPosition, Season } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { pickTarget } from '$lib/resume';
  import { favourite, positions as fetchPositions, unfavourite } from '$lib/me';

  let itemId = $derived(page.params.itemId ?? '');
  let item = $state<CatalogItem | null>(null);
  let seasons = $state<Season[]>([]);
  let saved = $state<SavedPosition[]>([]);
  let loading = $state(true);
  let error = $state('');

  $effect(() => {
    const id = itemId;
    let cancelled = false;
    loading = true;
    error = '';
    (async () => {
      try {
        const [i, s, p] = await Promise.all([
          api<CatalogItem>(`/api/items/${encodeURIComponent(id)}`),
          api<Season[]>(`/api/items/${encodeURIComponent(id)}/seasons`),
          fetchPositions(Number(id)).catch(() => [] as SavedPosition[]) // progress is optional
        ]);
        if (cancelled) return;
        item = i;
        seasons = s;
        saved = p;
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

  let byEpisode = $derived(new Map(saved.map((p) => [p.episodeRemoteId, p])));

  let target = $derived(pickTarget(seasons, saved));

  function percent(ep: { remoteId: string; durationSec: number | null }): number {
    const p = byEpisode.get(ep.remoteId);
    const total = p?.durationSec ?? ep.durationSec;
    if (!p || !total) return 0;
    return Math.min(100, Math.round((p.positionSec / total) * 100));
  }

  async function toggleFavourite() {
    if (!item) return;
    const was = item.favourite;
    item.favourite = !was;
    try {
      await (was ? unfavourite(item.id) : favourite(item.id));
    } catch {
      item.favourite = was;
    }
  }
</script>

<p><a href="/browse/series">‹ Back</a></p>
<h1>
  {item?.displayName ?? item?.name ?? 'Series'}
  {#if item}
    <button
      class="star"
      aria-pressed={item.favourite}
      aria-label={item.favourite ? 'Remove from favourites' : 'Add to favourites'}
      onclick={toggleFavourite}>{item.favourite ? '★' : '☆'}</button>
  {/if}
</h1>

{#if target}
  <p>
    <a class="primary" href={`/watch?item=${itemId}&episode=${encodeURIComponent(target.episodeRemoteId)}`}>
      {target.mode === 'continue' ? 'Continue' : 'Play'} {target.label}
    </a>
  </p>
{/if}

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
            {#if byEpisode.get(ep.remoteId)?.finished}
              <span class="count" aria-label="Watched">✓ Watched</span>
            {:else if ep.durationSec}
              <span class="count">{Math.round(ep.durationSec / 60)} min</span>
            {/if}
            {#if percent(ep) > 0 && !byEpisode.get(ep.remoteId)?.finished}
              <progress class="bar" max="100" value={percent(ep)} aria-label="Progress"></progress>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/each}
{/if}

<style>
  .star { background: none; border: 0; color: inherit; font-size: inherit; min-width: 48px; min-height: 48px; }
  .primary { display: inline-block; padding: 12px 20px; min-height: 48px; box-sizing: border-box; border-radius: 8px; background: #3b82f6; color: #fff; text-decoration: none; }
  .bar { width: 100%; height: 4px; flex-basis: 100%; }
  li :global(.row) { flex-wrap: wrap; }
</style>
