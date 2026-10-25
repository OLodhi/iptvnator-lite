<script lang="ts">
  type Range = { startSec: number; endSec: number };
  type Props = {
    mode: 'vod' | 'live';
    positionSec: number;
    durationSec?: number | null;
    window?: Range | null;
    programme?: { startSec: number; stopSec: number } | null;
    onSeek: (sec: number) => void;
    onScrubbing?: (active: boolean) => void;
  };

  let { mode, positionSec, durationSec = null, window: win = null, programme = null, onSeek, onScrubbing }: Props = $props();

  // The span the track represents, and the part of it that can be sought to.
  const span = $derived.by((): Range => {
    if (mode === 'vod') return { startSec: 0, endSec: durationSec ?? 0 };
    if (programme) return { startSec: programme.startSec, endSec: programme.stopSec };
    return win ?? { startSec: 0, endSec: 0 };
  });
  const seekable = $derived<Range>(mode === 'vod' ? span : (win ?? span));

  let dragSec = $state<number | null>(null);
  const shownSec = $derived(dragSec ?? positionSec);

  const length = $derived(span.endSec - span.startSec);
  const pct = (sec: number) => (length > 0 ? Math.min(100, Math.max(0, ((sec - span.startSec) / length) * 100)) : 0);

  let track: HTMLElement;

  function secAt(clientX: number): number {
    const rect = track.getBoundingClientRect();
    const f = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const sec = span.startSec + Math.min(1, Math.max(0, f)) * length;
    return Math.min(seekable.endSec, Math.max(seekable.startSec, sec));
  }

  function down(e: PointerEvent) {
    if (length <= 0) return;
    track.setPointerCapture?.(e.pointerId);
    dragSec = secAt(e.clientX);
    onScrubbing?.(true);
  }
  function move(e: PointerEvent) {
    if (dragSec !== null) dragSec = secAt(e.clientX);
  }
  function up(e: PointerEvent) {
    if (dragSec === null) return;
    const sec = secAt(e.clientX);
    dragSec = null;
    onScrubbing?.(false);
    onSeek(sec);
  }
  function cancel() {
    if (dragSec === null) return;
    dragSec = null;
    onScrubbing?.(false);
  }

  function clock(sec: number): string {
    return mode === 'vod' ? mss(sec) : new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function mss(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }
</script>

<div class="scrub">
  <span class="time">{clock(mode === 'vod' ? shownSec : span.startSec)}</span>
  <div
    class="track"
    role="slider"
    tabindex="0"
    aria-label="Seek"
    aria-valuemin={Math.round(span.startSec)}
    aria-valuemax={Math.round(span.endSec)}
    aria-valuenow={Math.round(shownSec)}
    bind:this={track}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={cancel}
  >
    <div class="rail">
      {#if mode === 'live' && length > 0}
        <i class="window" style:left="{pct(seekable.startSec)}%" style:width="{pct(seekable.endSec) - pct(seekable.startSec)}%"></i>
      {/if}
      {#if mode === 'vod'}<i class="done" style:width="{pct(shownSec)}%"></i>{/if}
    </div>
    <b class="thumb" style:left="{pct(shownSec)}%"></b>
  </div>
  <span class="time">{clock(span.endSec)}</span>
</div>

<style>
  .scrub {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .track {
    position: relative;
    flex: 1;
    height: 28px;
    display: flex;
    align-items: center;
    touch-action: none;
    cursor: pointer;
  }
  .rail {
    position: relative;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.25);
  }
  .rail i {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 2px;
  }
  .window {
    background: rgb(255 255 255 / 0.4);
  }
  .done {
    left: 0;
    background: var(--accent);
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    background: #fff;
    pointer-events: none;
  }
</style>
