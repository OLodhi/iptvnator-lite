<script lang="ts" module>
  /** `pressed` makes it a toggle, such as ★ Favourite. */
  export type WatchAction = { key: string; icon: string; label: string; pressed?: boolean; run: () => void };
</script>

<script lang="ts">
  import ActionSheet from '../ActionSheet.svelte';

  // A row of up to four. From four actions on, the fourth place is ⋯ More: a sheet of all but the first three.
  const CELLS = 4;

  type Props = { actions: WatchAction[]; moreOpen?: boolean };

  let { actions, moreOpen = $bindable(false) }: Props = $props();

  const overflow = $derived(actions.length >= CELLS);
  const shown = $derived(overflow ? actions.slice(0, CELLS - 1) : actions);
  const rest = $derived(
    actions.slice(shown.length).map((a) => ({ key: a.key, label: `${a.icon} ${a.label}`, run: a.run })),
  );

  // Nothing left to show (the phone turned, and ⤢ went): the sheet goes too, so it no longer holds the controls up.
  $effect(() => {
    if (!overflow) moreOpen = false;
  });
</script>

{#if actions.length > 0}
  <div class="actions">
    {#each shown as a (a.key)}
      <button type="button" class="act" class:on={a.pressed} aria-pressed={a.pressed} onclick={a.run}>
        <span aria-hidden="true">{a.icon}</span>{a.label}
      </button>
    {/each}
    {#if overflow}
      <button type="button" class="act" aria-haspopup="dialog" onclick={() => (moreOpen = true)}>
        <span aria-hidden="true">⋯</span>More
      </button>
    {/if}
  </div>
{/if}

<ActionSheet open={moreOpen} title="More" actions={rest} onClose={() => (moreOpen = false)} />

<style>
  .actions {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    padding: 12px 16px 14px;
  }
  .act {
    min-height: 56px;
    padding: 9px 4px 8px;
    border: 0;
    border-radius: 12px;
    background: var(--surface);
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    touch-action: manipulation;
  }
  .act:active {
    background: var(--surface-2);
  }
  .act span {
    display: block;
    margin-bottom: 2px;
    color: var(--text);
    font-size: 18px;
  }
  .act.on span {
    color: #ffd166;
  }
</style>
