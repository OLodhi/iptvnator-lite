<script lang="ts">
  type Action = { key?: string | number; label: string; danger?: boolean; disabled?: boolean; selected?: boolean; run: () => void };
  type Props = { open: boolean; title: string; actions: Action[]; onClose: () => void };

  let { open, title, actions, onClose }: Props = $props();

  // The long-press release lands under the finger on iOS and would hit the backdrop.
  let openedAt = 0;
  $effect(() => {
    if (open) openedAt = Date.now();
  });
  function backdropClick() {
    if (Date.now() - openedAt >= 300) onClose();
  }

  function choose(a: Action) {
    onClose();
    a.run();
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && onClose()} />

{#if open}
  <div class="backdrop" role="presentation" onclick={backdropClick}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
    <p class="sheet-title">{title}</p>
    <!-- A long list (a file's 40 subtitle tracks, a long series' seasons) scrolls; Cancel stays below it. -->
    <div class="sheet-list">
      {#each actions as a, i (a.key ?? `${i}:${a.label}`)}
        <button
          type="button"
          class="sheet-action"
          class:danger={a.danger}
          disabled={a.disabled}
          aria-pressed={a.selected}
          onclick={() => choose(a)}
        >{#if a.selected}<span class="tick" aria-hidden="true">✓</span>{/if}{a.label}</button>
      {/each}
    </div>
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
    /* Clear of the top safe area: vh where dvh isn't known, else the viewport as it is now (Safari's bars come and go). */
    max-height: calc(100vh - env(safe-area-inset-top) - 16px);
    max-height: calc(100dvh - env(safe-area-inset-top) - 16px);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom));
    background: var(--surface);
    border-radius: 16px 16px 0 0;
    border-top: 1px solid var(--border);
  }
  .sheet > :not(.sheet-list) {
    flex: none;
  }
  .sheet-list {
    min-height: 0;
    display: grid;
    gap: 1px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
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
  .sheet-action:disabled {
    color: var(--muted);
    cursor: default;
  }
  .tick {
    margin-right: 8px;
    color: var(--accent);
  }
  .sheet-action.danger {
    color: var(--danger);
  }
  .sheet-action.cancel {
    margin-top: 8px;
    font-weight: 600;
  }
</style>
