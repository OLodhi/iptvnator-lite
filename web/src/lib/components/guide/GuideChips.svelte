<script lang="ts">
  import type { GuideChip } from '@tv/shared';

  type Props = { chips: GuideChip[]; selected: string; onSelect: (filter: string) => void };
  let { chips, selected, onSelect }: Props = $props();
</script>

<div class="chips" role="group" aria-label="Filter">
  {#each chips as chip (chip.filter)}
    <button type="button" class="chip" class:on={chip.filter === selected} aria-pressed={chip.filter === selected} onclick={() => onSelect(chip.filter)}>
      {chip.label}
    </button>
  {/each}
</div>

<style>
  .chips {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 4px 0 8px;
    scrollbar-width: none;
  }
  .chips::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: none;
    min-height: 36px;
    padding: 0 14px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    touch-action: manipulation;
  }
  .chip.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
</style>
