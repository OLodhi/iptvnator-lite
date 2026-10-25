<script lang="ts">
  import type { CatalogItem } from '@tv/shared';
  import { longpress } from '$lib/actions/longpress';
  import Artwork from '$lib/components/Artwork.svelte';

  type Props = {
    /** The row's channel: its logo, and what a long-press hands over. */
    item: CatalogItem;
    /** Where a tap goes; without one the row does not link. */
    href: string | null;
    title: string;
    sub: string;
    /** How far through the programme on now is, 0 to 1; without one there is no bar. */
    progress?: number | null;
    action: 'play' | 'catchup' | null;
    onLongPress?: (item: CatalogItem) => void;
  };
  let { item, href, title, sub, progress = null, action, onLongPress }: Props = $props();
</script>

<svelte:element
  this={href ? 'a' : 'div'}
  class="entry"
  {href}
  draggable="false"
  use:longpress={{ onLongPress: () => onLongPress?.(item) }}
>
  <span class="thumb"><Artwork name={item.displayName} src={item.logoUrl} fit="contain" /></span>
  <span class="text">
    <span class="title">{title}</span>
    <span class="sub">{sub}</span>
    {#if progress !== null}
      <span class="bar" aria-hidden="true"><span style:width="{Math.round(progress * 100)}%"></span></span>
    {/if}
  </span>
  {#if action === 'play'}
    <span class="action play" aria-label="Watch live">▶</span>
  {:else if action === 'catchup'}
    <span class="action catchup">↺ Catch up</span>
  {/if}
</svelte:element>

<style>
  .entry {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 100%;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
  }
  a.entry:active {
    background: var(--surface);
  }
  .thumb {
    flex: none;
    width: 64px;
    height: 40px;
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .title,
  .sub {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-weight: 600;
  }
  .sub {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .bar {
    display: block;
    height: 2px;
    margin-top: 4px;
    border-radius: 1px;
    background: var(--border);
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .action {
    flex: none;
    padding-right: 4px;
    font-size: 0.85rem;
  }
  .play {
    font-size: 1.2rem;
  }
  .catchup {
    color: #ff9f43;
    font-weight: 600;
  }
</style>
