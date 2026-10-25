<script lang="ts">
  import type { Snapshot } from '@sveltejs/kit';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { CatalogItem, EpisodeDetail, ItemDetails, SavedPosition, SeasonDetail } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import ActionSheet from '$lib/components/ActionSheet.svelte';
  import EpisodeRow from '$lib/components/series/EpisodeRow.svelte';
  import SeasonSheet, { seasonSummary } from '$lib/components/series/SeasonSheet.svelte';
  import SeriesHeader from '$lib/components/series/SeriesHeader.svelte';
  import { favourite, itemDetails, markWatched, positions, unfavourite } from '$lib/me';
  import { messageFor } from '$lib/messages';
  import { pickTarget } from '$lib/resume';
  import { hideWatched, setHideWatched } from '$lib/series/hideWatched';
  import { bySeason, seasonOf } from '$lib/watch/episodes';
  import { watchHref } from '$lib/watch/links';

  /** The most episodes one PUT /api/me/watched takes. */
  const MARK_BATCH = 500;
  const FAILED = 'Something went wrong. Please try again.';

  const itemId = $derived(Number(page.params.itemId));
  let item = $state<CatalogItem | null>(null);
  let details = $state.raw<(ItemDetails & { kind: 'series' }) | null>(null);
  let saved = $state.raw<SavedPosition[]>([]);
  let loading = $state(true);
  let error = $state('');
  /** The season on show: the Continue/Play episode's when the page opens (marks don't move it), then the one picked. */
  let shown = $state<number | null>(null);
  let seasonSheetOpen = $state(false);
  let moreOpen = $state(false);
  /** The long-pressed episode, kept once its sheet closes: ActionSheet closes before it runs the choice. */
  let pressed = $state.raw<EpisodeDetail | null>(null);
  let pressedOpen = $state(false);
  let hiding = $state(hideWatched());
  let markError = $state('');
  let inAppHistory = false; // whether this page was reached from another page of the app, which Back can return to

  $effect(() => {
    const id = itemId;
    let cancelled = false;
    loading = true;
    error = '';
    (async () => {
      try {
        const [d, i, p] = await Promise.all([
          itemDetails(id),
          api<CatalogItem>(`/api/items/${id}`),
          positions(id).catch(() => [] as SavedPosition[]), // progress is optional
        ]);
        if (cancelled) return;
        if (d.kind !== 'series') {
          error = "This isn't a series.";
          return;
        }
        details = d;
        item = i;
        saved = p;
        const target = pickTarget(d.seasons, p);
        shown = (target && seasonOf(d.seasons, target.episodeRemoteId)?.season) ?? [...d.seasons].sort(bySeason)[0]?.season ?? null;
      } catch (err) {
        if (!cancelled) error = err instanceof ApiClientError ? messageFor(err) : FAILED;
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  /** In watching order, the specials last. */
  const seasons = $derived(details ? [...details.seasons].sort(bySeason) : []);
  const seasonsCount = $derived(seasons.filter((s) => s.season !== 0).length);
  const byEpisode = $derived(new Map(saved.map((p) => [p.episodeRemoteId, p])));
  const target = $derived(details ? pickTarget(details.seasons, saved) : null);
  const season = $derived(seasons.find((s) => s.season === shown) ?? seasons[0] ?? null);
  const rows = $derived(season ? (hiding ? season.episodes.filter((e) => !watched(e)) : season.episodes) : []);

  // Watched means finished: a mark made by hand may have no position at all.
  function watched(ep: EpisodeDetail): boolean {
    return byEpisode.get(ep.remoteId)?.finished === true;
  }
  function watchedCount(s: SeasonDetail): number {
    return s.episodes.filter(watched).length;
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

  /** Marks episodes watched or unwatched, in batches the server takes, then reads the positions again. */
  async function mark(episodes: EpisodeDetail[], on: boolean) {
    const id = itemId;
    const ids = [...new Set(episodes.map((e) => e.remoteId))];
    markError = '';
    try {
      for (let i = 0; i < ids.length; i += MARK_BATCH) await markWatched(id, ids.slice(i, i + MARK_BATCH), on);
    } catch (err) {
      markError = err instanceof ApiClientError ? messageFor(err) : FAILED;
    }
    // Even after a failure: an earlier batch may have landed.
    const fresh = await positions(id).catch(() => null);
    if (fresh && id === itemId) saved = fresh;
  }

  function longPressed(ep: EpisodeDetail) {
    pressed = ep;
    pressedOpen = true;
  }
  const pressedActions = $derived.by(() => {
    const ep = pressed;
    if (!ep) return [];
    const was = watched(ep);
    return [{ label: was ? 'Mark as unwatched' : 'Mark as watched', run: () => void mark([ep], !was) }];
  });

  const moreActions = $derived([
    {
      label: 'Mark season watched',
      disabled: !season,
      run: () => {
        if (season) void mark(season.episodes, true);
      },
    },
    { label: hiding ? 'Show watched episodes' : 'Hide watched episodes', run: toggleHiding },
  ]);
  function toggleHiding() {
    hiding = !hiding;
    setHideWatched(hiding);
  }

  // Coming from the watch page doesn't count: it only comes here itself, in place of its own entry, when it has no
  // in-app history either. Nor does the app's first load, which in a single-page app comes from a page with no URL.
  afterNavigate((nav) => {
    const from = nav.from?.url;
    if (from && from.pathname !== '/watch') inAppHistory = true;
  });
  // Returning to this entry (Back from an episode) restores what the page knew when it was left.
  export const snapshot: Snapshot<boolean> = {
    capture: () => inAppHistory,
    restore: (value) => {
      inAppHistory = value;
    },
  };

  /** Back where you came from. Opened from outside the app (a bookmark, a link, a relaunch), to the series list. */
  function back() {
    if (inAppHistory) return history.back();
    void goto('/browse/series', { replaceState: true });
  }
</script>

<div class="series">
  <!-- Over the header's backdrop, 10 px from the screen's edges like its ⋯ (main has 16 px of padding). -->
  <button type="button" class="round back" aria-label="Back" onclick={back}>‹</button>

  {#if loading}
    <p class="muted status">Loading…</p>
  {:else if error}
    <p class="error status" role="alert">{error}</p>
  {:else if item && details}
    <SeriesHeader
      {item}
      {details}
      {seasonsCount}
      {target}
      targetSaved={target ? (byEpisode.get(target.episodeRemoteId) ?? null) : null}
      onToggleFavourite={toggleFavourite}
      onMore={() => (moreOpen = true)}
    />

    {#if season}
      <div class="shead">
        <button type="button" class="season-button" aria-haspopup="dialog" onclick={() => (seasonSheetOpen = true)}>
          {season.name} ▾
        </button>
        <span class="summary">{seasonSummary(season.episodes.length, watchedCount(season))}</span>
      </div>
      {#if markError}<p class="error" role="alert">{markError}</p>{/if}
      {#if rows.length > 0}
        <div class="episodes">
          {#each rows as ep}
            <EpisodeRow
              episode={ep}
              {itemId}
              saved={byEpisode.get(ep.remoteId) ?? null}
              current={ep.remoteId === target?.episodeRemoteId}
              currentLabel="Up next"
              href={watchHref(itemId, { episode: ep.remoteId })}
              onLongPress={longPressed}
            />
          {/each}
        </div>
      {:else}
        <p class="muted">Every episode of this season is watched.</p>
      {/if}
    {:else}
      <p class="muted">No episodes yet.</p>
    {/if}

    <SeasonSheet
      open={seasonSheetOpen}
      {seasons}
      selected={season?.season ?? 0}
      {watchedCount}
      onPick={(n) => (shown = n)}
      onClose={() => (seasonSheetOpen = false)}
    />
    <ActionSheet open={moreOpen} title={item.displayName} actions={moreActions} onClose={() => (moreOpen = false)} />
    <ActionSheet
      open={pressedOpen}
      title={pressed ? `${pressed.episodeNum} · ${pressed.title}` : ''}
      actions={pressedActions}
      onClose={() => (pressedOpen = false)}
    />
  {/if}
</div>

<style>
  .series {
    position: relative;
    display: flow-root; /* the header's negative margin stays inside, so Back lines up with ⋯ */
  }
  .round {
    position: absolute;
    top: -6px;
    left: -6px;
    z-index: 2;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 0;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.45);
    color: #fff;
    font: inherit;
    font-size: 22px;
    cursor: pointer;
  }
  .status {
    padding-top: 40px;
  }
  .shead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 18px 0 8px;
    color: var(--muted);
    font-size: 13px;
  }
  .season-button {
    min-height: 40px;
    padding: 0 12px;
    border: 0;
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }
  .episodes {
    border-radius: 12px;
    background: var(--surface);
    overflow: hidden;
  }
</style>
