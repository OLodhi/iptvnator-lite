<script lang="ts">
  import type { CatalogItem, ItemDetails, SavedPosition } from '@tv/shared';
  import type { ResumeTarget } from '$lib/resume';
  import { watchHref } from '$lib/watch/links';
  import Artwork from '../Artwork.svelte';

  type Props = {
    item: CatalogItem;
    details: ItemDetails & { kind: 'series' };
    /** Seasons, not counting the specials. */
    seasonsCount: number;
    target: ResumeTarget | null;
    /** The target episode's saved position: Continue's time left and progress. */
    targetSaved: SavedPosition | null;
    onToggleFavourite: () => void;
    onMore: () => void;
  };

  let { item, details, seasonsCount, target, targetSaved, onToggleFavourite, onMore }: Props = $props();

  const poster = $derived(details.posterUrl ?? item.logoUrl);
  // The backdrop, else the poster blurred: one that fails to load gives way to the next.
  let failed = $state<string[]>([]);
  const backdrop = $derived([details.backdropUrl, poster].find((src) => src !== null && !failed.includes(src)) ?? null);

  const chips = $derived.by(() => {
    const year = details.year ?? item.year;
    const rating = details.rating ?? item.rating;
    const seasons = seasonsCount > 0 ? `${seasonsCount} ${seasonsCount === 1 ? 'season' : 'seasons'}` : null;
    return [
      { text: year ? String(year) : null },
      { text: details.genre },
      { text: rating ? `★ ${rating}` : null, star: true },
      { text: seasons },
    ].filter((c) => c.text);
  });
  const people = $derived([details.director ? `Created by ${details.director}` : null, details.cast].filter(Boolean).join(' · '));

  // Two lines of plot, and More only when there is more to show.
  let plot = $state<HTMLElement>();
  let plotOpen = $state(false);
  let clamped = $state(false);
  function measure() {
    if (plot && !plotOpen) clamped = plot.scrollHeight > plot.clientHeight + 1;
  }
  $effect(() => {
    void details.plot;
    measure();
  });

  const continuing = $derived(target?.mode === 'continue' ? targetSaved : null);
  const total = $derived.by(() => {
    if (!continuing) return null;
    const episode = details.seasons.flatMap((s) => s.episodes).find((e) => e.remoteId === target?.episodeRemoteId);
    return continuing.durationSec ?? episode?.durationSec ?? null;
  });
  const fraction = $derived(continuing && total ? Math.min(1, continuing.positionSec / total) : null);
  const label = $derived.by(() => {
    if (!target) return '';
    if (target.mode === 'next') return `▶ Play next: ${target.label}`;
    if (target.mode === 'play') return `▶ Play ${target.label}`;
    const left = continuing && total ? ` · ${Math.max(1, Math.round((total - continuing.positionSec) / 60))} min left` : '';
    return `▶ Continue ${target.label}${left}`;
  });
</script>

<svelte:window onresize={measure} />

<header class="hero">
  <div class="backdrop">
    {#if backdrop}
      <img
        src={backdrop}
        alt=""
        class:blurred={backdrop !== details.backdropUrl}
        onerror={() => (failed = [...failed, backdrop])}
      />
    {/if}
  </div>
  <button type="button" class="round menu" aria-label="More options" onclick={onMore}>⋯</button>
  <span class="poster"><Artwork name={item.displayName} src={poster} /></span>
  <div class="titleblock">
    <h1>{item.displayName}</h1>
    {#if chips.length > 0}
      <div class="chips">
        {#each chips as chip}<span class:star={chip.star}>{chip.text}</span>{/each}
      </div>
    {/if}
  </div>
</header>

<div class="about">
  {#if details.plot}
    <p class="plot" class:open={plotOpen} bind:this={plot}>{details.plot}</p>
    {#if clamped || plotOpen}
      <button type="button" class="plot-toggle" aria-expanded={plotOpen} onclick={() => (plotOpen = !plotOpen)}>
        {plotOpen ? 'Less' : 'More'}
      </button>
    {/if}
  {/if}
  {#if people}<p class="people">{people}</p>{/if}
  <div class="cta">
    {#if target}
      <a class="play" href={watchHref(item.id, { episode: target.episodeRemoteId })}>
        <span class="label">{label}</span>
        {#if fraction !== null}
          <span class="pbar" aria-hidden="true"><i style:width="{Math.round(fraction * 100)}%"></i></span>
        {/if}
      </a>
    {/if}
    <button
      type="button"
      class="fav"
      class:on={item.favourite}
      aria-pressed={item.favourite}
      aria-label={item.favourite ? 'Remove from favourites' : 'Add to favourites'}
      onclick={onToggleFavourite}
    >★<small>{item.favourite ? 'Saved' : 'Save'}</small></button>
  </div>
</div>

<style>
  /* The artwork runs to the screen's edges, past main's 16 px padding, and fades into the page. */
  .hero {
    position: relative;
    height: 240px;
    margin: -16px -16px 0;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: linear-gradient(160deg, var(--surface-2), var(--bg) 80%);
  }
  .backdrop img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .backdrop img.blurred {
    filter: blur(24px);
    transform: scale(1.2);
    opacity: 0.8;
  }
  .backdrop::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(rgb(14 17 22 / 0.35), transparent 35%, rgb(14 17 22 / 0.65) 70%, var(--bg));
  }
  .round {
    position: absolute;
    top: 10px;
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
    font-size: 20px;
    cursor: pointer;
  }
  .menu {
    right: 10px;
  }
  .poster {
    position: absolute;
    left: 16px;
    bottom: -34px;
    z-index: 1;
    width: 104px;
    height: 156px;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.6);
  }
  .titleblock {
    position: absolute;
    left: 134px;
    right: 16px;
    bottom: -26px;
    z-index: 1;
  }
  h1 {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    margin: 0;
    font-size: 26px;
    font-weight: 800;
    line-height: 1.1;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
    color: #cfd5df;
    font-size: 12px;
  }
  .chips span {
    padding: 2px 8px;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.1);
  }
  .chips .star {
    color: #ffd166;
    background: rgb(255 209 102 / 0.12);
  }
  .about {
    padding-top: 46px;
  }
  .plot {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    margin: 0;
    color: #d6dbe4;
    font-size: 14px;
  }
  .plot.open {
    display: block;
  }
  .plot-toggle {
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .people {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
  }
  .cta {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }
  .play {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    min-height: var(--row-height);
    padding: 11px 14px;
    border-radius: 12px;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    text-decoration: none;
  }
  .pbar {
    position: relative;
    height: 3px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.35);
  }
  .pbar > i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 2px;
    background: #fff;
  }
  .fav {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 56px;
    border: 0;
    border-radius: 12px;
    background: var(--surface);
    color: var(--muted);
    font: inherit;
    font-size: 18px;
    cursor: pointer;
  }
  .fav small {
    font-size: 10px;
  }
  .fav.on {
    color: #ffd166;
  }
</style>
