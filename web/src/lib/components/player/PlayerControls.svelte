<script lang="ts">
  import type { PlayerState } from '../../player/state.svelte.ts';
  import ScrubBar from './ScrubBar.svelte';
  import LivePill from './LivePill.svelte';

  const HIDE_AFTER_MS = 3000;
  const DOUBLE_TAP_MS = 300;
  const SKIP_SEC = 10;

  type Props = {
    state: PlayerState;
    /** Catch-up counts from the programme's start, so its bar is the VOD one. */
    mode: 'live' | 'vod';
    title: string;
    subtitle?: string;
    /** "Next · 21:00 Title", shown under the bar when fullscreen. */
    nextLabel?: string;
    fullscreen: boolean;
    /** The programme the live bar spans, in epoch seconds. */
    programme?: { startSec: number; stopSec: number } | null;
    /** Live: added to the stream's own time to put it on the programme's clock. */
    liveShiftSec?: number;
    /** The probed length of a movie, episode or catch-up programme (the element's own duration grows while remuxing). */
    durationSec?: number | null;
    /** True while a sheet is open: the controls stay up. */
    holding?: boolean;
    /** True while something covers the video (starting, an error): no gestures or transport, and the controls stay up. */
    covered?: boolean;
    caps: { pip: boolean; airplay: boolean };
    tracks: { audio: boolean; subtitles: boolean };
    /** What each chip has chosen: "English", "Off". */
    trackLabels?: { audio: string | null; subtitles: string | null };
    onTogglePlay: () => void;
    onSkip: (delta: number) => void;
    onSeek: (sec: number) => void;
    onGoLive?: () => void;
    /** Catch-up of a programme still airing: "● Watch live" beside the bar. */
    onWatchLive?: () => void;
    onChannel?: (dir: -1 | 1) => void;
    onPip: () => void;
    onAirPlay: () => void;
    onToggleMute: () => void;
    /** ⤢ in and out of fullscreen; without it there is no ⤢ (sideways, where turning the phone back is the way out). */
    onFullscreen?: () => void;
    onTracks: (kind: 'audio' | 'subtitles') => void;
    onBack: () => void;
  };

  let {
    state: player, mode, title, subtitle, nextLabel, fullscreen, programme = null, liveShiftSec = 0, durationSec = null, holding = false,
    covered = false, caps, tracks, trackLabels, onTogglePlay, onSkip, onSeek, onGoLive, onWatchLive, onChannel, onPip, onAirPlay, onToggleMute,
    onFullscreen, onTracks, onBack,
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

  // The live bar is the programme on the clock; positions and seeks stay in the stream's own time.
  const shift = $derived(mode === 'live' ? liveShiftSec : 0);
  const scrubWindow = $derived(player.window && { startSec: player.window.startSec + shift, endSec: player.window.endSec + shift });
  const vodTotal = $derived(durationSec ?? player.durationSec);

  const chip = (name: string, chosen: string | null | undefined) => (chosen ? `${name}: ${chosen}` : name);
</script>

<div class="controls" class:hidden={!shown} class:covered onpointerdowncapture={() => activity++} role="presentation">
  <div class="surface" role="presentation" onclick={surfaceClick}></div>

  {#if flash}<div class="flash">{flash}</div>{/if}

  <div class="top">
    <!-- Upright, the page's top bar has the one Back. -->
    {#if fullscreen}
      <button type="button" class="vbtn" aria-label="Back" onclick={onBack}>‹</button>
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

  <!-- Outside the transport, so it stays usable while the next channel starts. -->
  {#if fullscreen && onChannel}
    <div class="channels">
      <button type="button" class="vbtn" aria-label="Next channel" onclick={() => onChannel(1)}>▲</button>
      <span aria-hidden="true">CH</span>
      <button type="button" class="vbtn" aria-label="Previous channel" onclick={() => onChannel(-1)}>▼</button>
    </div>
  {/if}

  <div class="center">
    <button type="button" class="vbtn" aria-label="Back 10 seconds" onclick={() => onSkip(-SKIP_SEC)}>↺10</button>
    <button type="button" class="vbtn big" aria-label={player.paused ? 'Play' : 'Pause'} onclick={onTogglePlay}>{player.paused ? '▶' : '❚❚'}</button>
    <button type="button" class="vbtn" aria-label="Forward 10 seconds" onclick={() => onSkip(SKIP_SEC)}>10↻</button>
  </div>

  <div class="bottom">
    <div class="bar-row">
      <div class="bar">
        <ScrubBar
          {mode}
          positionSec={player.positionSec + shift}
          durationSec={vodTotal}
          window={scrubWindow}
          programme={mode === 'live' ? programme : null}
          onSeek={(sec) => onSeek(sec - shift)}
          onScrubbing={(active) => (scrubbing = active)}
        />
      </div>
      {#if mode === 'live' && onGoLive}<LivePill behindSec={player.behindSec} onGoLive={onGoLive} />{/if}
      {#if onWatchLive}<button type="button" class="watch-live" onclick={onWatchLive}>● Watch live</button>{/if}
      {#if onFullscreen}
        <button type="button" class="vbtn" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onclick={onFullscreen}>⤢</button>
      {/if}
    </div>
    {#if fullscreen && (nextLabel || tracks.audio || tracks.subtitles)}
      <div class="extras">
        <span class="next">{nextLabel ?? ''}</span>
        <span class="chips">
          {#if tracks.subtitles}
            <button type="button" class="chip" onclick={() => onTracks('subtitles')}>{chip('💬 Subtitles', trackLabels?.subtitles)}</button>
          {/if}
          {#if tracks.audio}<button type="button" class="chip" onclick={() => onTracks('audio')}>{chip('♪ Audio', trackLabels?.audio)}</button>{/if}
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
    /* A quick second tap is a skip, never iOS's double-tap zoom: on the tap surface and the buttons on it alike. */
    touch-action: manipulation;
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
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 11px;
    pointer-events: none;
  }
  .channels > button {
    pointer-events: auto;
  }
  .watch-live {
    flex: none;
    padding: 4px 10px;
    border: 0;
    border-radius: 999px;
    background: #4a5160;
    color: #dfe3ea;
    font: inherit;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
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
