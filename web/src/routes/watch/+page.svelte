<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Hls from 'hls.js';
  import { beforeNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import type { PlayResponse } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { getClientId } from '$lib/clientId';
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

  const reporter = createProgressReporter({ report: reportPosition, now: Date.now });

  const playback = createPlayback({
    play: (req, signal) => api<PlayResponse>('/api/play', { method: 'POST', body: JSON.stringify(req), signal }),
    releaseSession: (sessionId, clientId) => releaseSession(sessionId, clientId),
    startHeartbeat: (sessionId, clientId, opts) => startHeartbeat(sessionId, clientId, opts),
    attachStream: (v, url, opts) => attachStream(v, url, { Hls, ...opts }),
    clientId: getClientId,
    onStarted: ({ offsetSec, durationSec }) => {
      if (!video || durationSec === null) return; // live: nothing to resume
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
      error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
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
    void playback.start({ itemId: Number(q.get('item')), episodeRemoteId, startAtSec }, video);
  }

  function restart() {
    start(playback.isVod() && video ? playback.absoluteSec(video) : 0);
  }

  onMount(() => {
    const q = page.url.searchParams;
    const t = Number(q.get('t')) || 0;
    if (t) return start(t);
    const episode = q.get('episode');
    positions(Number(q.get('item'))).then(
      (saved) => {
        const mine = pickResume(saved, episode);
        if (mine) resumeAt = mine.positionSec;
        else start(0);
      },
      () => start(0) // no saved position available: just play
    );
  });
  beforeNavigate(playback.teardown);
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

<video bind:this={video} playsinline controls autoplay></video>

{#if stopped}
  <button class="stopped" onclick={restart}>Playback stopped. Tap to restart.</button>
{/if}
