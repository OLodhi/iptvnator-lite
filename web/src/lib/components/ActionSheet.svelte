<script lang="ts">
  type Action = { label: string; danger?: boolean; run: () => void };
  type Props = { open: boolean; title: string; actions: Action[]; onClose: () => void };

  let { open, title, actions, onClose }: Props = $props();

  function choose(a: Action) {
    onClose();
    a.run();
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && onClose()} />

{#if open}
  <div class="backdrop" role="presentation" onclick={onClose}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
    <p class="sheet-title">{title}</p>
    {#each actions as a (a.label)}
      <button type="button" class="sheet-action" class:danger={a.danger} onclick={() => choose(a)}>{a.label}</button>
    {/each}
    <button type="button" class="sheet-action cancel" onclick={onClose}>Cancel</button>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.55);
    z-index: 20;
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 21;
    max-width: 720px;
    margin: 0 auto;
    display: grid;
    gap: 1px;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom));
    background: var(--surface);
    border-radius: 16px 16px 0 0;
    border-top: 1px solid var(--border);
  }
  .sheet-title {
    margin: 0;
    padding: 10px 12px;
    color: var(--muted);
    font-size: 0.9rem;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet-action {
    min-height: var(--row-height);
    border: 0;
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .sheet-action:active {
    background: var(--border);
  }
  .sheet-action.danger {
    color: var(--danger);
  }
  .sheet-action.cancel {
    margin-top: 8px;
    font-weight: 600;
  }
</style>
