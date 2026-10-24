<script lang="ts">
  import type { GuideSource } from '@tv/shared';
  import { guideSources, setGuideSource } from '$lib/guide';
  import { messageFor } from '$lib/messages';
  import { ApiClientError } from '$lib/api';

  type Props = {
    open: boolean;
    item: { id: number; providerId: number; displayName: string } | null;
    onClose: () => void;
    /** Called after the map was saved, so the list can reload. */
    onMapped: () => void;
  };
  let { open, item, onClose, onMapped }: Props = $props();

  let q = $state('');
  let results = $state<GuideSource[]>([]);
  let busy = $state(false);
  let error = $state('');
  let done = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let seq = 0;

  // Reset whenever the sheet opens for a channel.
  $effect(() => {
    if (open) {
      q = '';
      results = [];
      error = '';
      done = false;
      busy = false;
    }
    return () => {
      clearTimeout(timer);
      controller?.abort();
    };
  });

  function onInput() {
    clearTimeout(timer);
    controller?.abort();
    const text = q.trim();
    if (!text || !item) {
      results = [];
      return;
    }
    const providerId = item.providerId;
    timer = setTimeout(async () => {
      const mine = ++seq;
      controller = new AbortController();
      try {
        const found = await guideSources(providerId, text, controller.signal);
        if (mine === seq) results = found;
      } catch (err) {
        if (mine !== seq || (err instanceof DOMException && err.name === 'AbortError')) return;
        error = err instanceof ApiClientError ? messageFor(err) : 'Search failed. Please try again.';
      }
    }, 250);
  }

  async function choose(key: string | null) {
    if (!item || busy) return;
    busy = true;
    error = '';
    try {
      await setGuideSource(item.id, key);
      done = true;
      onMapped();
    } catch (err) {
      error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && onClose()} />

{#if open && item}
  <div class="backdrop" role="presentation" onclick={onClose}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Map guide channel">
    <p class="sheet-title">{item.displayName}</p>
    <input type="search" placeholder="Search guide channels" bind:value={q} oninput={onInput} aria-label="Search guide channels" />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if done}<p class="done" role="status">Guide will update in a minute or two</p>{/if}
    <div class="list">
      <button type="button" class="result auto" disabled={busy} onclick={() => choose(null)}>Automatic matching</button>
      {#each results as r (r.key)}
        <button type="button" class="result" disabled={busy} onclick={() => choose(r.key)}>
          <span class="rname">{r.name}</span>
          <span class="rkey">{r.key}</span>
        </button>
      {/each}
    </div>
    <button type="button" class="result cancel" onclick={onClose}>{done ? 'Close' : 'Cancel'}</button>
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
    max-height: 80vh;
    margin: 0 auto;
    display: grid;
    gap: 8px;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom));
    background: var(--surface);
    border-radius: 16px 16px 0 0;
    border-top: 1px solid var(--border);
    grid-template-rows: auto auto auto auto minmax(0, 1fr) auto;
  }
  .sheet-title {
    margin: 0;
    padding: 10px 12px 2px;
    color: var(--muted);
    font-size: 0.9rem;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  input {
    min-height: var(--row-height);
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
  }
  .list {
    display: grid;
    gap: 1px;
    overflow-y: auto;
    align-content: start;
  }
  .result {
    min-height: var(--row-height);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    padding: 6px 12px;
    border: 0;
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .result:active {
    background: var(--border);
  }
  .auto {
    font-weight: 600;
  }
  .rkey {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .cancel {
    align-items: center;
    font-weight: 600;
  }
  .done {
    margin: 0;
    color: var(--accent);
    text-align: center;
  }
  .error {
    margin: 0;
  }
</style>
