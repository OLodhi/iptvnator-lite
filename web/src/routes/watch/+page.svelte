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
  import { createPlayback } from '$lib/player/playback';
  import { releaseSession, startHeartbeat } from '$lib/session';

  let video = $state<HTMLVideoElement>();
  let error = $state('');
  let stopped = $state(false);

  const playback = createPlayback({
    play: (req, signal) => api<PlayResponse>('/api/play', { method: 'POST', body: JSON.stringify(req), signal }),
    releaseSession: (sessionId, clientId) => releaseSession(sessionId, clientId),
    startHeartbeat: (sessionId, clientId, opts) => startHeartbeat(sessionId, clientId, opts),
    attachStream: (v, url) => attachStream(v, url, { Hls }),
    clientId: getClientId,
    onGone: () => {
      stopped = true;
    },
    onError: (err) => {
      error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    }
  });

  function start(startAtSec: number) {
    if (!video) return;
    error = '';
    stopped = false;
    const q = page.url.searchParams;
    const episodeRemoteId = q.get('episode') ?? undefined;
    void playback.start({ itemId: Number(q.get('item')), episodeRemoteId, startAtSec }, video);
  }

  function restart() {
    start(playback.isVod() && video ? Math.floor(video.currentTime) : 0);
  }

  onMount(() => start(Number(page.url.searchParams.get('t')) || 0));
  beforeNavigate(playback.teardown);
  onDestroy(playback.teardown);
</script>

<svelte:window onpagehide={playback.teardown} />

<p><button class="stopped" onclick={() => history.back()}>‹ Back</button></p>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

<video bind:this={video} playsinline controls autoplay></video>

{#if stopped}
  <button class="stopped" onclick={restart}>Playback stopped. Tap to restart.</button>
{/if}
