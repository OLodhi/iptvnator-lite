<script lang="ts">
  import VirtualList from '../VirtualList.svelte';

  let { items, onEnd, columns = 1 }: { items: string[]; onEnd?: () => void; columns?: number } = $props();
</script>

<VirtualList {items} rowHeight={50} {columns} {onEnd}>
  {#snippet row(item)}
    <div class="r">{item}</div>
  {/snippet}
</VirtualList>
