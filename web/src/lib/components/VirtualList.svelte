<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { visibleRange } from '$lib/virtual/window';

  type Props = {
    items: T[];
    rowHeight: number;
    columns?: number;
    /** Called once per list length when the rendered window is within 3 rows of the end. */
    onEnd?: () => void;
    row: Snippet<[item: T, index: number]>;
  };

  let { items, rowHeight, columns = 1, onEnd, row }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewport = $state(800);
  let frame = 0;

  // Window scrolling: the list's own offset from the document top is measured on every update,
  // so content above it (headers, other sections) can change height freely.
  function measure() {
    frame = 0;
    if (!host) return;
    scrollTop = -host.getBoundingClientRect().top;
    viewport = window.innerHeight;
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure);
  }

  $effect(() => {
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  });

  const range = $derived(visibleRange({ scrollTop, viewport, rowHeight, columns, count: items.length }));
  const visible = $derived(items.slice(range.start, range.end));

  let firedFor = -1;
  $effect(() => {
    const count = items.length;
    if (!onEnd || count === 0 || firedFor === count) return;
    if (Math.ceil((count - range.end) / columns) <= 3) {
      firedFor = count;
      onEnd();
    }
  });
</script>

<div bind:this={host} class="vlist">
  <div style:height="{range.padTop}px" aria-hidden="true"></div>
  <div
    class="vlist-rows"
    style:grid-template-columns="repeat({columns}, minmax(0, 1fr))"
    style:grid-auto-rows="{rowHeight}px"
  >
    {#each visible as item, i (range.start + i)}
      {@render row(item, range.start + i)}
    {/each}
  </div>
  <div style:height="{range.padBottom}px" aria-hidden="true"></div>
</div>

<style>
  .vlist-rows {
    display: grid;
  }
  .vlist-rows > :global(*) {
    min-width: 0;
    overflow: hidden;
  }
</style>
