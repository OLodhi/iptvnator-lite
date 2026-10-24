<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Hls from 'hls.js';
  import { beforeNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import type { PlayRequest, PlayResponse } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { getClientId } from '$lib/clientId';
  import { messageFor } from '$lib/messages';
  import { attachStream, type StreamHandle } from '$lib/player/attach';
  import { releaseSession, startHeartbeat } from '$lib/session';

  let video = $state<HTMLVideoElement>();
  let error = $state('');
  let stopped = $state(false);

  let handle: StreamHandle | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let active: { sessionId: string; clientId: string; vod: boolean } | undefined;

  function teardown() {
    stopHeartbeat?.();
    stopHeartbeat = undefined;
    handle?.destroy();
    handle = undefined;
    if (active) {
      void releaseSession(active.sessionId, active.clientId);
      active = undefined;
    }
  }

  async function start(startAtSec: number) {
    error = '';
    stopped = false;
    const q = page.url.searchParams;
    const itemId = Number(q.get('item'));
    const episode = q.get('episode');
    const clientId = getClientId();
    const body: PlayRequest = { itemId, clientId, startAtSec };
    if (episode) body.episodeRemoteId = episode;
    try {
      const res = await api<PlayResponse>('/api/play', { method: 'POST', body: JSON.stringify(body) });
      if (!video) return;
      active = { sessionId: res.sessionId, clientId, vod: res.durationSec !== null };
      handle = attachStream(video, res.url, { Hls });
      stopHeartbeat = startHeartbeat(res.sessionId, clientId, {
        onGone: () => {
          stopped = true;
        }
      });
      void video.play().catch(() => {
        // autoplay can be refused; the controls are there
      });
    } catch (err) {
      error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    }
  }

  function restart() {
    const resumeAt = active?.vod && video ? Math.floor(video.currentTime) : 0;
    teardown();
    void start(resumeAt);
  }

  onMount(() => {
    void start(Number(page.url.searchParams.get('t')) || 0);
  });
  beforeNavigate(teardown);
  onDestroy(teardown);
</script>

<svelte:window onpagehide={teardown} />

<p><button class="stopped" onclick={() => history.back()}>‹ Back</button></p>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

<video bind:this={video} playsinline controls autoplay></video>

{#if stopped}
  <button class="stopped" onclick={restart}>Playback stopped. Tap to restart.</button>
{/if}
