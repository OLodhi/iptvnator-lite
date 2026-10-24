<script lang="ts">
  import type { CatalogItem } from '@tv/shared';
  import { longpress } from '$lib/actions/longpress';
  import Artwork from './Artwork.svelte';
  import NowLine from './NowLine.svelte';

  type Props = {
    item: CatalogItem;
    onToggleFavourite: (item: CatalogItem) => void;
    onLongPress?: (item: CatalogItem) => void;
  };
  let { item, onToggleFavourite, onLongPress }: Props = $props();
</script>

<div class="channel-row">
  <a
    class="main"
    href={`/watch?item=${item.id}`}
    draggable="false"
    use:longpress={{ onLongPress: () => onLongPress?.(item) }}
  >
    <span class="logo"><Artwork name={item.displayName} src={item.logoUrl} fit="contain" /></span>
    <span class="text">
      <span class="name">{item.displayName}</span>
      {#if item.now}<NowLine now={item.now} />{/if}
    </span>
  </a>
  <button
    type="button"
    class="star"
    class:on={item.favourite}
    aria-pressed={item.favourite}
    aria-label={item.favourite ? `Remove ${item.displayName} from favourites` : `Add ${item.displayName} to favourites`}
    onclick={() => onToggleFavourite(item)}>{item.favourite ? '★' : '☆'}</button
  >
</div>

<style>
  .channel-row {
    display: flex;
    align-items: center;
    height: 100%;
    border-bottom: 1px solid var(--border);
  }
  .main {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 4px 0 2px;
    color: var(--text);
    text-decoration: none;
  }
  .main:active {
    background: var(--surface);
  }
  .logo {
    flex: none;
    width: 48px;
    height: 48px;
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .name {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .star {
    flex: none;
    width: 52px;
    height: 100%;
    border: 0;
    background: none;
    color: var(--muted);
    font-size: 1.5rem;
    cursor: pointer;
    touch-action: manipulation;
  }
  .star.on {
    color: #ffc542;
  }
</style>
