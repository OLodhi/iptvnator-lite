<script lang="ts">
  import type { CatalogItem, EpisodeDetail, ItemDetails, NowProgramme } from '@tv/shared';
  import { formatClock, progress, sharedClock } from '$lib/guide/time';
  import type { CatchupWindow } from '$lib/watch/params';
  import Artwork from '../Artwork.svelte';

  type Props = {
    /** What is playing; null until the item says whether it is a channel or a movie. */
    kind: 'live' | 'catchup' | 'movie' | 'episode' | null;
    item: CatalogItem | null;
    onNow: NowProgramme | null;
    catchup: CatchupWindow | null;
    /** Where the channel sits in the list below: "Sports · channel 4 of 85". */
    where?: string | null;
    /** Live: "Next · 21:00 Title". */
    next?: string | null;
    /** A movie's or series' details, once fetched. */
    details?: ItemDetails | null;
    /** The episode playing and its season, once the series' details are known. */
    episode?: { season: number; episode: EpisodeDetail } | null;
  };

  let { kind, item, onNow, catchup, where = null, next = null, details = null, episode = null }: Props = $props();

  const clock = sharedClock();
  const fraction = $derived(onNow ? progress(onNow.startSec, onNow.stopSec, clock.nowMs) : 0);
  const catchupDetails = $derived(
    catchup
      ? [catchup.title, `${formatClock(catchup.startSec)}–${formatClock(catchup.stopSec)}`]
          .filter(Boolean)
          .map((part) => ` · ${part}`)
          .join('')
      : '',
  );
  /** A movie: "1995 · Crime · ★ 8.3", with whatever the provider has. An episode: "Season 3 · Episode 2 · Title · 33 min". */
  const meta = $derived.by(() => {
    if (kind === 'movie') {
      const rating = details?.rating ?? item?.rating;
      return [details?.year ?? item?.year, details?.genre, rating ? `★ ${rating}` : null].filter(Boolean).join(' · ');
    }
    if (kind === 'episode' && episode) {
      const { season, episode: ep } = episode;
      const length = ep.durationSec ? `${Math.round(ep.durationSec / 60)} min` : null;
      return [season === 0 ? 'Specials' : `Season ${season}`, `Episode ${ep.episodeNum}`, ep.title, length].filter(Boolean).join(' · ');
    }
    return '';
  });
</script>

<section class="info">
  {#if kind === 'live' || kind === 'catchup'}
    {#if item}
      <div class="chan">
        <span class="logo"><Artwork name={item.displayName} src={item.logoUrl} fit="contain" /></span>
        <span class="names">
          <span class="chname">{item.displayName}</span>
          {#if where}<span class="where">{where}</span>{/if}
        </span>
      </div>
    {/if}
    {#if kind === 'catchup'}
      <p class="catchup"><span class="cu">↺ Catch-up</span>{catchupDetails}</p>
    {:else if onNow}
      <div class="on-now">
        <p class="prog">{onNow.title}</p>
        <div class="times">
          <time>{formatClock(onNow.startSec)}</time>
          <span class="bar" aria-hidden="true"><i style:width="{Math.round(fraction * 100)}%"></i></span>
          <time>{formatClock(onNow.stopSec)}</time>
        </div>
      </div>
    {:else if item && !item.now}
      <p class="none">No guide information</p>
    {/if}
    {#if kind === 'live' && next}<p class="next">{next}</p>{/if}
  {:else if item}
    <!-- A movie's title, or an episode's series. -->
    <p class="prog title">{item.displayName}</p>
    {#if meta}<p class="meta">{meta}</p>{/if}
    {#if kind === 'movie' && details?.plot}<p class="plot">{details.plot}</p>{/if}
  {/if}
</section>

<style>
  .info {
    padding: 14px 16px 6px;
  }
  p {
    margin: 0;
  }
  .chan {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .logo {
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 9px;
    overflow: hidden;
    background: var(--surface-2);
  }
  .names {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .chname,
  .where {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chname {
    font-weight: 700;
    font-size: 15px;
  }
  .where {
    color: var(--muted);
    font-size: 12px;
  }
  .next {
    margin-top: 8px;
    color: var(--muted);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .prog {
    margin: 12px 0 6px;
    font-size: 19px;
    font-weight: 700;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }
  .prog.title {
    margin-top: 2px;
  }
  .times {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    position: relative;
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-2);
  }
  .bar > i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 2px;
    background: var(--accent);
  }
  .catchup {
    margin-top: 12px;
    font-size: 15px;
    overflow-wrap: anywhere;
  }
  .cu {
    color: #ff9f43;
    font-weight: 700;
  }
  .none {
    margin-top: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .meta {
    color: var(--muted);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .plot {
    display: -webkit-box;
    margin-top: 8px;
    overflow: hidden;
    color: #cfd5df;
    font-size: 13px;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }
</style>
