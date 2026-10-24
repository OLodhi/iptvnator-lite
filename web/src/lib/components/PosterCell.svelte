<script lang="ts">
  import type { CatalogItem } from '@tv/shared';
  import { longpress } from '$lib/actions/longpress';
  import Artwork from './Artwork.svelte';

  type Props = {
    item: CatalogItem;
    href: string;
    /** Caption's second line, e.g. an episode label; defaults to the year. */
    sub?: string | null;
    /** 0..1 watched fraction, drawn as a bar over the poster. */
    progress?: number | null;
    onLongPress?: (item: CatalogItem) => void;
  };
  let { item, href, sub, progress = null, onLongPress }: Props = $props();
  const subtitle = $derived(sub ?? (item.year ? String(item.year) : ''));
</script>

<a
  class="cell pressable"
  {href}
  draggable="false"
  use:longpress={{ onLongPress: () => onLongPress?.(item) }}
>
  <span class="poster">
    <Artwork name={item.displayName} src={item.logoUrl} />
    {#if item.favourite}<span class="fav" aria-label="Favourite">★</span>{/if}
    {#if progress !== null && progress > 0}
      <span class="bar"><span style:width="{Math.min(100, progress * 100)}%"></span></span>
    {/if}
  </span>
  <span class="title">{item.displayName}</span>
  {#if subtitle}<span class="sub">{subtitle}</span>{/if}
</a>

<style>
  .cell {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 6px 12px;
    color: var(--text);
    text-decoration: none;
    height: 100%;
  }
  .poster {
    position: relative;
    display: block;
    aspect-ratio: 2 / 3;
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface-2);
    flex: none;
  }
  .cell:active .poster {
    opacity: 0.75;
  }
  .fav {
    position: absolute;
    top: 4px;
    right: 6px;
    color: #ffc542;
    text-shadow: 0 1px 3px #000;
    font-size: 1rem;
  }
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgb(0 0 0 / 0.6);
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .title {
    font-size: 0.82rem;
    line-height: 16px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sub {
    font-size: 0.75rem;
    line-height: 16px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
