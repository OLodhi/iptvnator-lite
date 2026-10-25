<script lang="ts">
  type Props = { behindSec: number; onGoLive: () => void };

  let { behindSec, onGoLive }: Props = $props();

  const live = $derived(behindSec < 15);
  const label = $derived.by(() => {
    const s = Math.round(behindSec);
    return `● −${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
</script>

<button type="button" class="pill" class:live class:behind={!live} aria-label="Go to live" onclick={onGoLive}>
  {live ? '● LIVE' : label}
</button>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border: 0;
    border-radius: 999px;
    font: inherit;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .live {
    background: #ff453a;
    color: #fff;
  }
  .behind {
    background: #4a5160;
    color: #dfe3ea;
  }
</style>
