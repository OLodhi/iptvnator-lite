<script lang="ts">
  import type { PlayerState } from '../../player/state.svelte.ts';
  import ScrubBar from './ScrubBar.svelte';
  import LivePill from './LivePill.svelte';

  const HIDE_AFTER_MS = 3000;
  const DOUBLE_TAP_MS = 300;
  const SKIP_SEC = 10;

  type Props = {
    state: PlayerState;
    mode: 'live' | 'catchup' | 'vod';
    title: string;
    subtitle?: string;
    /** "Next · 21:00 Title", shown under the bar when fullscreen. */
    nextLabel?: string;
    fullscreen: boolean;
    /** The programme the live and catch-up bar spans. */
    programme?: { startSec: number; stopSec: number } | null;
    /** The probed length of a movie or episode (the element's own duration grows while remuxing). */
    durationSec?: number | null;
    /** True while a sheet is open: the controls stay up. */
    holding?: boolean;
    /** True while something covers the video (starting, an error): no gestures or transport, and the controls stay up. */
    covered?: boolean;
    caps: { pip: boolean; airplay: boolean };
    tracks: { audio: boolean; subtitles: boolean };
    onTogglePlay: () => void;
    onSkip: (delta: number) => void;
    onSeek: (sec: number) => void;
    onGoLive?: () => void;
    onChannel?: (dir: -1 | 1) => void;
    onPip: () => void;
    onAirPlay: () => void;
    onToggleMute: () => void;
    onFullscreen: () => void;
    onTracks: (kind: 'audio' | 'subtitles') => void;
    onBack: () => void;
  };

  let {
    state: player, mode, title, subtitle, nextLabel, fullscreen, programme = null, durationSec = null, holding = false, covered = false,
    caps, tracks, onTogglePlay, onSkip, onSeek, onGoLive, onChannel, onPip, onAirPlay, onToggleMute, onFullscreen, onTracks, onBack,
  }: Props = $props();

  let visible = $state(true);
  let scrubbing = $state(false);
  let activity = $state(0);
  let flash = $state<string | null>(null);

  const hold = $derived(player.paused || scrubbing || holding || covered);
  const shown = $derived(visible || hold);

  // Holding makes the controls visible, and releasing the hold starts the 3 s countdown.
  $effect(() => {
    if (hold) {
      visible = true;
      return;
    }
    void activity;
    if (!visible) return;
    const t = setTimeout(() => (visible = false), HIDE_AFTER_MS);
    return () => clearTimeout(t);
  });

  let lastTap: number | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  function surfaceClick(e: MouseEvent) {
    if (covered) {
      lastTap = null;
      return;
    }
    const now = Date.now();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const second = lastTap !== null && now - lastTap <= DOUBLE_TAP_MS;
    if (second && f !== 0.5 && (f < 1 / 3 || f > 2 / 3)) {
      lastTap = null;
      const delta = f < 0.5 ? -SKIP_SEC : SKIP_SEC;
      visible = true;
      activity++;
      onSkip(delta);
      flash = delta < 0 ? '−10 s' : '+10 s';
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => (flash = null), 600);
      return;
    }
    lastTap = second ? null : now;
    visible = !shown;
    activity++;
  }

  $effect(() => () => clearTimeout(flashTimer));

  const scrubWindow = $derived(player.window);
  const vodTotal = $derived(durationSec ?? player.durationSec);
</script>

<div class="controls" class:hidden={!shown} class:covered onpointerdowncapture={() => activity++} role="presentation">
  <div class="surface" role="presentation" onclick={surfaceClick}></div>

  {#if flash}<div class="flash">{flash}</div>{/if}

  <div class="top">
    <button type="button" class="vbtn" aria-label="Back" onclick={onBack}>‹</button>
    {#if fullscreen}
      <div class="title-row">
        <b>{title}</b>
        {#if subtitle}<span class="sub">{subtitle}</span>{/if}
      </div>
    {:else}
      <span class="grow"></span>
    {/if}
    {#if caps.pip}<button type="button" class="vbtn" aria-label="Picture in picture" onclick={onPip}>⧉</button>{/if}
    {#if caps.airplay}<button type="button" class="vbtn" aria-label="AirPlay" onclick={onAirPlay}>⎚</button>{/if}
    <button type="button" class="vbtn" aria-label={player.muted ? 'Unmute' : 'Mute'} onclick={onToggleMute}>{player.muted ? '🔇' : '🔊'}</button>
  </div>

  <div class="center">
    {#if fullscreen && onChannel}
      <div class="channels">
        <button type="button" class="vbtn" aria-label="Next channel" onclick={() => onChannel(1)}>▲</button>
        <button type="button" class="vbtn" aria-label="Previous channel" onclick={() => onChannel(-1)}>▼</button>
      </div>
    {/if}
    <button type="button" class="vbtn" aria-label="Back 10 seconds" onclick={() => onSkip(-SKIP_SEC)}>↺10</button>
    <button type="button" class="vbtn big" aria-label={player.paused ? 'Play' : 'Pause'} onclick={onTogglePlay}>{player.paused ? '▶' : '❚❚'}</button>
    <button type="button" class="vbtn" aria-label="Forward 10 seconds" onclick={() => onSkip(SKIP_SEC)}>10↻</button>
  </div>

  <div class="bottom">
    <div class="bar-row">
      <div class="bar">
        <ScrubBar
          mode={mode === 'vod' ? 'vod' : 'live'}
          positionSec={player.positionSec}
          durationSec={vodTotal}
          window={scrubWindow}
          {programme}
          {onSeek}
          onScrubbing={(active) => (scrubbing = active)}
        />
      </div>
      {#if mode === 'live' && onGoLive}<LivePill behindSec={player.behindSec} onGoLive={onGoLive} />{/if}
      <button type="button" class="vbtn" aria-label="Fullscreen" onclick={onFullscreen}>⤢</button>
    </div>
    {#if fullscreen && (nextLabel || tracks.audio || tracks.subtitles)}
      <div class="extras">
        <span class="next">{nextLabel ?? ''}</span>
        <span class="chips">
          {#if tracks.subtitles}<button type="button" class="chip" onclick={() => onTracks('subtitles')}>💬 Subtitles</button>{/if}
          {#if tracks.audio}<button type="button" class="chip" onclick={() => onTracks('audio')}>♪ Audio</button>{/if}
        </span>
      </div>
    {/if}
  </div>
</div>

<style>
  .controls {
    position: absolute;
    inset: 0;
    color: var(--text);
    pointer-events: none;
    background: linear-gradient(rgb(0 0 0 / 0.6), transparent 28%, transparent 62%, rgb(0 0 0 / 0.75));
    transition: opacity 0.2s;
  }
  .controls.hidden {
    opacity: 0;
  }
  .controls.hidden > :not(.surface),
  .controls.covered > .center,
  .controls.covered > .bottom {
    visibility: hidden;
  }
  .surface {
    position: absolute;
    inset: 0;
    pointer-events: auto;
  }
  .top,
  .bottom,
  .center {
    position: absolute;
    left: 12px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .top {
    top: 10px;
  }
  .bottom {
    bottom: 10px;
    flex-direction: column;
    align-items: stretch;
  }
  .center {
    top: 50%;
    transform: translateY(-50%);
    justify-content: center;
    gap: 36px;
  }
  .top > *,
  .center > *,
  .bottom > * {
    pointer-events: auto;
  }
  .center,
  .top,
  .bottom {
    pointer-events: none;
  }
  .grow {
    flex: 1;
  }
  .title-row {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    font-size: 15px;
  }
  .title-row b {
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--muted);
    font-size: 12px;
  }
  .vbtn {
    min-width: 40px;
    height: 40px;
    padding: 0 10px;
    border: 0;
    border-radius: 12px;
    background: rgb(0 0 0 / 0.4);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .vbtn.big {
    min-width: 56px;
    height: 56px;
    font-size: 20px;
  }
  .channels {
    position: absolute;
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .bar {
    flex: 1;
    min-width: 0;
  }
  .extras {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    font-size: 12px;
  }
  .next {
    color: var(--muted);
  }
  .chips {
    display: flex;
    gap: 8px;
  }
  .chip {
    border: 0;
    border-radius: 999px;
    padding: 5px 11px;
    background: rgb(0 0 0 / 0.4);
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .flash {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 8px 16px;
    border-radius: 12px;
    background: rgb(0 0 0 / 0.55);
    font-weight: 600;
    pointer-events: none;
  }
</style>
