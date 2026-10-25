<script lang="ts" module>
  /** What covers the video instead of playback. */
  export type PlayerView =
    | { kind: 'starting' }
    | { kind: 'resume'; atSec: number }
    /** The server refused or failed the start: the one-stream limit, a catch-up window, a timeout. */
    | { kind: 'failed'; message: string }
    /** The <video> itself failed. */
    | { kind: 'error' }
    | { kind: 'stopped' }
    | { kind: 'tapToPlay' };
</script>

<script lang="ts">
  import Artwork from '../Artwork.svelte';

  type Props = {
    view: PlayerView;
    /** The channel, movie or series; empty until known. */
    name: string;
    /** The channel logo, or the movie or series poster. */
    artwork: string | null;
    poster: boolean;
    onResume: () => void;
    onStartOver: () => void;
    onRestart: () => void;
    onPlay: () => void;
  };

  let { view, name, artwork, poster, onResume, onStartOver, onRestart, onPlay }: Props = $props();

  function mmss(sec: number): string {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
</script>

<div class="states">
  {#if view.kind === 'starting'}
    <div class="starting" role="status">
      {#if name}
        <span class="art" class:poster><Artwork {name} src={artwork} fit={poster ? 'cover' : 'contain'} /></span>
      {/if}
      <span class="spinner" aria-hidden="true"></span>
      <p>{name ? `Starting ${name}…` : 'Starting…'}</p>
    </div>
  {:else if view.kind === 'resume'}
    <div class="choice">
      <button type="button" class="btn" onclick={onResume}>Resume from {mmss(view.atSec)}</button>
      <button type="button" class="btn ghost" onclick={onStartOver}>Start over</button>
    </div>
  {:else if view.kind === 'failed'}
    <p class="card" role="alert">{view.message}</p>
  {:else if view.kind === 'error'}
    <div class="card">
      <p role="alert">This video can't be played right now.</p>
      <button type="button" class="btn" onclick={onRestart}>Tap to restart</button>
    </div>
  {:else if view.kind === 'stopped'}
    <div role="alert">
      <button type="button" class="card tap" onclick={onRestart}>Playback stopped. Tap to restart.</button>
    </div>
  {:else}
    <button type="button" class="btn" onclick={onPlay}>▶ Tap to play</button>
  {/if}
</div>

<style>
  /* Clear of the controls' top row, whose Back stays usable. */
  .states {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 52px 22px 12px;
    text-align: center;
    font-size: 13px;
    pointer-events: none;
  }
  .states button {
    pointer-events: auto;
  }
  p {
    margin: 0;
  }
  .starting {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .art {
    width: 48px;
    height: 48px;
    border-radius: 9px;
    overflow: hidden;
    background: var(--surface-2);
  }
  .art.poster {
    width: 40px;
    height: 60px;
  }
  .spinner {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 3px solid rgb(255 255 255 / 0.2);
    border-top-color: #fff;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .choice {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }
  .card {
    display: grid;
    gap: 10px;
    justify-items: center;
    max-width: 320px;
    padding: 12px 16px;
    border: 0;
    border-radius: 12px;
    background: rgb(14 17 22 / 0.88);
    color: var(--text);
    font: inherit;
  }
  .card.tap {
    min-height: 44px;
    cursor: pointer;
  }
  .btn {
    min-height: 44px;
    padding: 0 16px;
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
