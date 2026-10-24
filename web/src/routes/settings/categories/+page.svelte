<script lang="ts">
  import { onDestroy } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { CurationView, Kind } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { curation, saveCuration } from '$lib/me';
  import { firstProvider } from '$lib/provider';
  import { createPickerState, type PickerState } from '$lib/curation/picker';
  import CategoryPicker from '$lib/components/CategoryPicker.svelte';

  const kinds: { kind: Kind; label: string }[] = [
    { kind: 'live', label: 'Live' },
    { kind: 'movie', label: 'Movies' },
    { kind: 'series', label: 'Series' },
  ];
  const fromUrl = page.url.searchParams.get('kind');

  let kind = $state<Kind>(kinds.some((k) => k.kind === fromUrl) ? (fromUrl as Kind) : 'live');
  let providerId = $state<number | null>(null);
  let view = $state.raw<CurationView | null>(null);
  let picker = $state.raw<PickerState | null>(null);
  let rev = $state(0);
  let loading = $state(true);
  let noProvider = $state(false);
  let error = $state('');
  let saving = $state(false);
  let saved = $state(false);
  let pending = $state.raw<(() => void) | null>(null); // what the user was doing when we asked about unsaved changes
  let leaving = false;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  const dirty = $derived(rev > 0);
  const kept = $derived.by(() => {
    void rev;
    return picker?.keptCount() ?? 0;
  });

  const fail = (err: unknown) => (err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.');

  async function load(k: Kind) {
    const mine = ++seq;
    loading = true;
    error = '';
    view = null;
    picker = null;
    rev = 0;
    try {
      if (providerId === null) {
        const provider = await firstProvider();
        if (mine !== seq) return;
        if (!provider) {
          noProvider = true;
          return;
        }
        providerId = provider.id;
      }
      const result = await curation(providerId, k);
      if (mine !== seq) return;
      view = result;
      picker = createPickerState(result);
    } catch (err) {
      if (mine === seq) error = fail(err);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  $effect(() => {
    void load(kind);
    return () => {
      seq++;
    };
  });

  /** Runs `next` now, or after the user decides what to do with unsaved changes. */
  function attempt(next: () => void) {
    if (dirty && !leaving) pending = next;
    else next();
  }

  beforeNavigate((nav) => {
    if (!dirty || leaving || !nav.to) return;
    const to = nav.to.url;
    nav.cancel();
    pending = () => {
      leaving = true;
      void goto(to);
    };
  });

  const choose = (k: Kind) => {
    if (k !== kind) attempt(() => (kind = k));
  };

  async function persist(): Promise<boolean> {
    if (!picker || providerId === null) return false;
    saving = true;
    error = '';
    try {
      await saveCuration(providerId, kind, picker.toUpdate());
      rev = 0;
      return true;
    } catch (err) {
      error = fail(err);
      return false;
    } finally {
      saving = false;
    }
  }

  async function done() {
    if (!(await persist())) return;
    saved = true;
    leaving = true;
    timer = setTimeout(() => void goto(`/browse/${kind}`), 700);
  }

  async function saveAndContinue() {
    const next = pending;
    if (next && (await persist())) {
      pending = null;
      next();
    }
  }

  function discard() {
    const next = pending;
    rev = 0;
    pending = null;
    next?.();
  }
</script>

<h1>Choose categories</h1>

<div class="seg" role="group" aria-label="Kind">
  {#each kinds as k (k.kind)}
    <button type="button" aria-pressed={kind === k.kind} onclick={() => choose(k.kind)}>{k.label}</button>
  {/each}
</div>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

{#if noProvider}
  <p>No provider yet. <a href="/settings/providers">Add one</a>.</p>
{:else if loading}
  <p class="muted" aria-busy="true">Loading categories…</p>
{:else if view && picker}
  {#if view.newCount > 0}
    <p class="muted note">{view.newCount} new {view.newCount === 1 ? 'category' : 'categories'} — review. They start hidden.</p>
  {/if}
  {#if picker.total() === 0}
    <p class="muted">This provider has no {kinds.find((k) => k.kind === kind)?.label.toLowerCase()} categories.</p>
  {:else}
    {#key view}
      <CategoryPicker
        style={view.style}
        groups={view.groups}
        {picker}
        {rev}
        onchange={() => (rev += 1)}
      />
    {/key}
  {/if}

  <div class="footer-space" aria-hidden="true"></div>
  <div class="footer">
    <span class="kept" aria-live="polite">{saved ? 'Saved' : `${kept} of ${picker.total()} kept`}</span>
    <button type="button" class="primary" disabled={saving || saved} onclick={done}>{saving ? 'Saving…' : 'Done'}</button>
  </div>
{/if}

{#if pending}
  <div class="backdrop" role="presentation"></div>
  <div class="prompt" role="alertdialog" aria-modal="true" aria-label="Unsaved changes">
    <p><strong>Save your changes?</strong></p>
    <p class="muted">You changed which categories are kept.</p>
    <button type="button" class="primary" disabled={saving} onclick={saveAndContinue}>Save</button>
    <button type="button" class="alt" onclick={discard}>Discard</button>
    <button type="button" class="alt" onclick={() => (pending = null)}>Keep editing</button>
  </div>
{/if}

<style>
  .seg {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 4px;
    margin-bottom: 12px;
    border-radius: 12px;
    background: var(--surface);
  }
  .seg button {
    min-height: 44px;
    border: 0;
    border-radius: 9px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .seg button[aria-pressed='true'] {
    background: var(--surface-2);
    color: var(--text);
  }
  .note {
    margin: 0 0 12px;
  }
  .footer-space {
    height: 72px;
  }
  .footer {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(var(--tabbar-height) + env(safe-area-inset-bottom));
    z-index: 5;
    max-width: 720px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .kept {
    font-weight: 600;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: rgb(0 0 0 / 0.55);
  }
  .prompt {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 21;
    max-width: 720px;
    margin: 0 auto;
    display: grid;
    gap: 8px;
    padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
    border-radius: 16px 16px 0 0;
    background: var(--surface);
  }
  .prompt p {
    margin: 0;
  }
  .alt {
    min-height: var(--row-height);
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
</style>
