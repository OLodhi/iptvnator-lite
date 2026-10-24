<script lang="ts" generics="T">
  import { untrack, type Snippet } from 'svelte';
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

  // Window scrolling: the list's offset is re-measured on scroll, resize, when `items` change and
  // when the list's surroundings change size (a banner appearing above it), via the ResizeObserver below.
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
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    if (host?.parentElement) ro?.observe(host.parentElement);
    ro?.observe(document.body);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  });

  const range = $derived(visibleRange({ scrollTop, viewport, rowHeight, columns, count: items.length }));
  const visible = $derived(items.slice(range.start, range.end));

  $effect(() => {
    items; // re-measure when the data changes
    measure();
  });

  // onEnd fires once per approach to the end of each distinct list. The guard resets when the data
  // set changes: it shrinks, starts with a different first item, or is a new array of the same length.
  let firedFor = -1;
  let lastFirst: T | undefined;
  let lastItems: T[] | undefined;
  $effect(() => {
    const count = items.length;
    const first = items[0];
    const lastVisibleRow = Math.min(Math.ceil(count / columns), Math.ceil((scrollTop + viewport) / rowHeight));
    const dataChanged =
      count < firedFor || first !== lastFirst || (count === firedFor && items !== lastItems);
    lastFirst = first;
    lastItems = items;
    if (dataChanged) firedFor = -1;
    if (!onEnd || count === 0 || firedFor === count) return;
    if (Math.ceil(count / columns) - lastVisibleRow <= 3) {
      firedFor = count;
      untrack(onEnd);
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
