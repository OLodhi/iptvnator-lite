<script lang="ts">
  import { untrack } from 'svelte';
  import type { EpisodeDetail } from '@tv/shared';

  type Props = {
    next: EpisodeDetail;
    /** The next episode's season, for "S3 E3"; EpisodeDetail doesn't carry it. */
    season?: number;
    /** How long the countdown runs. */
    seconds?: number;
    onPlay: () => void;
    onCancel: () => void;
  };

  let { next, season, seconds = 5, onPlay, onCancel }: Props = $props();

  let left = $state(untrack(() => seconds));
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Each second schedules the next, so the countdown doesn't wait on a render.
  function tick() {
    timer = setTimeout(() => {
      left -= 1;
      if (left > 0) tick();
      else onPlay();
    }, 1000);
  }

  $effect(() => {
    tick();
    return () => clearTimeout(timer);
  });

  function play() {
    clearTimeout(timer);
    onPlay();
  }

  function cancel() {
    clearTimeout(timer);
    onCancel();
  }
</script>

<section class="up-next" aria-label="Up next">
  <p class="label">Up next · {season === undefined ? `Episode ${next.episodeNum}` : `S${season} E${next.episodeNum}`}</p>
  <p class="title">{next.title}</p>
  <div class="buttons">
    <button type="button" class="btn" onclick={play}>Play in {left}</button>
    <button type="button" class="btn ghost" onclick={cancel}>Cancel</button>
  </div>
</section>

<style>
  .up-next {
    position: absolute;
    right: 10px;
    bottom: 10px;
    width: 190px;
    padding: 9px 10px;
    border-radius: 12px;
    background: rgb(14 17 22 / 0.92);
    font-size: 12px;
  }
  p {
    margin: 0;
  }
  .label {
    color: var(--muted);
    font-size: 11px;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 700;
  }
  .buttons {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .btn {
    min-height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 10px;
    background: var(--accent);
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .btn.ghost {
    background: rgb(255 255 255 / 0.12);
    color: var(--text);
  }
</style>
