<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Hls from 'hls.js';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { CatalogItem, PlayResponse } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { getClientId } from '$lib/clientId';
  import { formatClock } from '$lib/guide/time';
  import { messageFor } from '$lib/messages';
  import { attachStream } from '$lib/player/attach';
  import { positions, reportPosition } from '$lib/me';
  import { createPlayback } from '$lib/player/playback';
  import { pickResume } from '$lib/resume';
  import { createProgressReporter } from '$lib/player/progress';
  import { releaseSession, startHeartbeat } from '$lib/session';

  let video = $state<HTMLVideoElement>();
  let error = $state('');
  let stopped = $state(false);
  let resumeAt = $state<number | null>(null); // set while the Resume / Start over prompt is showing
  let item = $state<CatalogItem | null>(null); // only for the On now line and From start: fetched per item, and again when its programme ends
  let checkedAt = $state(Date.now()); // when the On now programme was last held against the clock
  let itemSeq = 0; // bumped on every item fetch and item change, so only the latest answer lands
  let itemTimer: ReturnType<typeof setTimeout> | undefined;
  let begun = 0; // bumped on every begin(), so a late positions() answer for an old URL is ignored
  // An answer whose programme has already ended by this device's clock (one ahead of the server's) is retried after this.
  const RETRY_MS = 30_000;
  const MAX_TIMEOUT_MS = 2 ** 31 - 1; // a longer setTimeout fires at once

  /** Catch-up mode: from and to are positive integers and to is after from. Anything else plays normally. */
  const catchup = $derived.by(() => {
    const q = page.url.searchParams;
    const from = q.get('from') ?? '';
    const to = q.get('to') ?? '';
    const positive = /^[1-9]\d*$/;
    if (!positive.test(from) || !positive.test(to)) return null;
    if (!Number.isSafeInteger(Number(from)) || !Number.isSafeInteger(Number(to)) || Number(to) <= Number(from)) return null;
    return { startSec: Number(from), stopSec: Number(to), title: (q.get('title') ?? '').trim() };
  });

  const reporter = createProgressReporter({ report: reportPosition, now: Date.now });

  const playback = createPlayback({
    play: (req, signal) => api<PlayResponse>('/api/play', { method: 'POST', body: JSON.stringify(req), signal }),
    releaseSession: (sessionId, clientId) => releaseSession(sessionId, clientId),
    startHeartbeat: (sessionId, clientId, opts) => startHeartbeat(sessionId, clientId, opts),
    attachStream: (v, url, opts) => attachStream(v, url, { Hls, ...opts }),
    clientId: getClientId,
    onStarted: ({ offsetSec, durationSec }) => {
      // Live has nothing to resume; catch-up has a duration but is never progress-tracked.
      if (!video || durationSec === null || catchup) return;
      const q = page.url.searchParams;
      reporter.attach(video, {
        itemId: Number(q.get('item')),
        episodeRemoteId: q.get('episode') ?? undefined,
        offsetSec,
        durationSec
      });
    },
    onStopping: () => {
      void reporter.flush();
      reporter.detach();
    },
    onGone: () => {
      stopped = true;
    },
    onError: (err) => {
      if (!(err instanceof ApiClientError)) error = 'Something went wrong. Please try again.';
      // The server says why a catch-up window was refused: no catch-up on this channel, too old, and so on.
      else error = err.code === 'VALIDATION' && catchup ? err.message : messageFor(err);
    }
  });

  function mmss(sec: number): string {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function start(startAtSec: number) {
    resumeAt = null;
    if (!video) return;
    error = '';
    stopped = false;
    const q = page.url.searchParams;
    const episodeRemoteId = q.get('episode') ?? undefined;
    const window = catchup ? { startSec: catchup.startSec, stopSec: catchup.stopSec } : undefined;
    // The item may still be loading: a plain ?item= then counts as a movie (for live, hls.js just starts at the new session's first segment).
    const kind = window ? 'catchup' : episodeRemoteId ? 'episode' : item?.kind === 'live' ? 'live' : 'movie';
    void playback.start(
      { kind, itemId: Number(q.get('item')), episodeRemoteId, startAtSec: window ? 0 : startAtSec, catchup: window },
      video
    );
  }

  function restart() {
    start(playback.isVod() && video && !catchup ? playback.absoluteSec(video) : 0);
  }

  /** Starts playback for the current URL: catch-up, an explicit time, the resume prompt, or from the top. */
  function begin() {
    const mine = ++begun;
    if (!video) return;
    if (catchup) return start(0);
    const q = page.url.searchParams;
    const t = Number(q.get('t')) || 0;
    if (t) return start(t);
    const episode = q.get('episode');
    positions(Number(q.get('item'))).then(
      (saved) => {
        if (mine !== begun) return;
        const best = pickResume(saved, episode);
        if (best) resumeAt = best.positionSec;
        else start(0);
      },
      () => mine === begun && start(0) // no saved position available: just play
    );
  }

  // SvelteKit reuses this component when only the query changes, so the URL drives playback.
  $effect(() => {
    void page.url.search;
    untrack(begin);
  });

  const itemId = $derived(Number(page.url.searchParams.get('item')));
  // Hidden once its stop time has been seen to pass, until a fresh answer arrives.
  const onNow = $derived(item?.kind === 'live' && item.now && item.now.stopSec * 1000 > checkedAt ? item.now : null);

  /** Fetches the item and schedules the next fetch for when its programme ends. Resolves null if superseded or failed. */
  function fetchItem(id: number): Promise<CatalogItem | null> {
    const mine = ++itemSeq;
    return api<CatalogItem>(`/api/items/${id}`).then(
      (it) => {
        if (mine !== itemSeq) return null;
        clearTimeout(itemTimer);
        item = it ?? null;
        checkedAt = Date.now();
        const stopSec = item?.now?.stopSec;
        if (stopSec !== undefined) {
          const untilStop = stopSec * 1000 - checkedAt;
          itemTimer = setTimeout(() => refetchItem(id), untilStop > 0 ? Math.min(untilStop, MAX_TIMEOUT_MS) : RETRY_MS);
        }
        return item;
      },
      () => null // no On now line is better than a blocked player
    );
  }

  /** Hides an ended programme at once and fetches what is on now. */
  function refetchItem(id: number): Promise<CatalogItem | null> {
    checkedAt = Date.now();
    return fetchItem(id);
  }

  // Keyed on the item id alone, so switching between live and catch-up for one item doesn't refetch or blank the line.
  $effect(() => {
    const id = itemId;
    item = null;
    void fetchItem(id);
    // Timers may not run while the phone sleeps: check again when the app comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetchItem(id);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      itemSeq++;
      clearTimeout(itemTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  async function fromStart() {
    let current = item;
    // The programme ended before the page noticed: start the one on now instead, if any.
    if (current?.now && current.now.stopSec * 1000 <= Date.now()) current = await refetchItem(current.id);
    const now = current?.now;
    if (!current || !now) return;
    void goto(`/watch?item=${current.id}&from=${now.startSec}&to=${now.stopSec}&title=${encodeURIComponent(now.title)}`);
  }

  beforeNavigate((nav) => {
    // A same-route navigation restarts playback itself; tearing down here would strand the video if it fails or is cancelled.
    if (nav.to?.url.pathname === '/watch') return;
    playback.teardown();
  });
  onDestroy(playback.teardown);
</script>

<svelte:window onpagehide={playback.teardown} />

<p><button class="stopped" onclick={() => history.back()}>‹ Back</button></p>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

{#if resumeAt !== null}
  <p class="resume">
    <button class="stopped" onclick={() => start(resumeAt ?? 0)}>Resume from {mmss(resumeAt)}</button>
    <button class="stopped" onclick={() => start(0)}>Start over</button>
  </p>
{/if}

{#if catchup}
  <p class="onnow">
    {['↺ Catch-up', catchup.title, `${formatClock(catchup.startSec)}–${formatClock(catchup.stopSec)}`].filter(Boolean).join(' · ')}
  </p>
{:else if onNow}
  <p class="onnow">
    On now: {onNow.title} · until {formatClock(onNow.stopSec)}
    {#if (item?.catchupDays ?? 0) > 0}
      <button class="stopped" onclick={fromStart}>↺ From start</button>
    {/if}
  </p>
{/if}

<video bind:this={video} playsinline controls autoplay></video>

{#if stopped}
  <button class="stopped" onclick={restart}>Playback stopped. Tap to restart.</button>
{/if}

<style>
  .onnow {
    margin: 8px 0;
    overflow-wrap: anywhere;
  }
  /* The button sits on its own full-width row under the line, so it never wraps at 320px. */
  .onnow button {
    min-height: 44px;
  }
</style>
