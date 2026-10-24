<script lang="ts">
  import type { GuideMeta } from '@tv/shared';

  // Placeholder: Task 14 replaces this with the real grid, keeping the testid and props.
  let { meta, filter }: { meta: GuideMeta; filter: string } = $props();
</script>

<div data-testid="guide-grid" data-filter={filter} data-provider={meta.providerId}></div>
