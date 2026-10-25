<script lang="ts">
  import type { EpisodeDetail, SavedPosition } from '@tv/shared';
  import { longpress } from '$lib/actions/longpress';
  import Artwork from '../Artwork.svelte';

  type Props = {
    episode: EpisodeDetail;
    /** The series. */
    itemId: number;
    /** This episode's saved position, if any. */
    saved: SavedPosition | null;
    /** The episode playing (the watch page) or up next (the series page). */
    current?: boolean;
    /** What the current row says it is. */
    currentLabel?: string;
    href: string;
    onLongPress?: (ep: EpisodeDetail) => void;
  };

  let { episode, saved, current = false, currentLabel = 'Playing', href, onLongPress }: Props = $props();

  // Watched means finished: a mark made by hand may have no position at all.
  const watched = $derived(saved?.finished === true);
  const atSec = $derived(saved && !watched ? saved.positionSec : 0);
  const total = $derived(saved?.durationSec ?? episode.durationSec);
  const fraction = $derived(atSec > 0 && total ? Math.min(1, atSec / total) : null);
  const status = $derived.by(() => {
    if (watched) return 'watched';
    if (atSec > 0) return total ? `${Math.max(1, Math.round((total - atSec) / 60))} min left` : '';
    return episode.durationSec ? `${Math.round(episode.durationSec / 60)} min` : '';
  });
</script>

<a
  class="ep-row"
  class:current
  {href}
  aria-current={current ? 'true' : undefined}
  draggable="false"
  use:longpress={{ onLongPress: () => onLongPress?.(episode) }}
>
  <span class="thumb">
    <Artwork name={episode.title} src={episode.imageUrl} />
    {#if watched}
      <span class="done" aria-hidden="true">✓</span>
    {:else if fraction !== null}
      <span class="prog" aria-hidden="true"><i style:width="{Math.round(fraction * 100)}%"></i></span>
    {/if}
  </span>
  <span class="ept">
    <span class="n">{episode.episodeNum} · {episode.title}</span>
    <span class="s">{status} {#if episode.quality}<span class="badge">{episode.quality}</span>{/if}</span>
  </span>
  {#if current}<span class="flag">{currentLabel}</span>{/if}
</a>

<style>
  .ep-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
  }
  .ep-row:first-child {
    border-top: 0;
  }
  .ep-row:active {
    background: var(--surface-2);
  }
  .ep-row.current {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .thumb {
    position: relative;
    flex: none;
    width: 72px;
    height: 41px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--surface-2);
  }
  .done {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(14 17 22 / 0.55);
    font-size: 14px;
  }
  .prog {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgb(255 255 255 / 0.25);
  }
  .prog > i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--accent);
  }
  .ept {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .n {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 700;
  }
  .s {
    margin-top: 2px;
    color: var(--muted);
    font-size: 12px;
  }
  .badge {
    display: inline-block;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 10px;
  }
  .flag {
    flex: none;
    color: var(--accent);
    font-size: 11px;
    font-weight: 600;
  }
</style>
