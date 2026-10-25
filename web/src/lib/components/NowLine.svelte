<script lang="ts">
  import type { NowProgramme } from '@tv/shared';
  import { progress, sharedClock } from '$lib/guide/time';

  let { now }: { now: NowProgramme } = $props();
  const clock = sharedClock();
  const fraction = $derived(progress(now.startSec, now.stopSec, clock.nowMs));
  // The list is not refetched when the programme ends, so an ended one is hidden rather than shown at 100%.
  const airing = $derived(clock.nowMs < now.stopSec * 1000);
</script>

{#if airing}
  <span class="now-title">{now.title}</span>
  <span class="now-bar" aria-hidden="true"><span style:width="{Math.round(fraction * 100)}%"></span></span>
{/if}

<style>
  .now-title {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .now-bar {
    display: block;
    height: 2px;
    margin-top: 4px;
    border-radius: 1px;
    background: var(--border);
  }
  .now-bar > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
</style>
