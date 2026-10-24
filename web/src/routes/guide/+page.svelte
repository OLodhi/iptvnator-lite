<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { GuideMeta, GuideStatus, GuideView } from '@tv/shared';
  import { ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { guideMeta, guideStatus, refreshGuide, saveGuidePrefs } from '$lib/guide';
  import GuideChips from '$lib/components/guide/GuideChips.svelte';
  import GuideGrid from '$lib/components/guide/GuideGrid.svelte';
  import WhatsOn from '$lib/components/guide/WhatsOn.svelte';

  const errorText = (err: unknown) => (err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.');

  let meta = $state<GuideMeta | null>(null);
  let view = $state<GuideView>('whatson');
  let filter = $state('all');
  let loading = $state(true);
  let error = $state('');
  let refreshing = $state(false);
  let failure = $state('');
  let gone = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const hasGuide = $derived(!!meta?.status && meta.status.programmes > 0);
  const chipLabel = $derived(meta?.chips.find((c) => c.filter === filter)?.label ?? 'All');

  async function loadMeta() {
    try {
      const m = await guideMeta();
      if (gone) return;
      meta = m;
      view = m.prefs.view;
      filter = m.chips.some((c) => c.filter === m.prefs.filter) ? m.prefs.filter : 'all';
      error = '';
      if (m.providerId !== null && m.status?.state === 'running' && !refreshing) {
        refreshing = true; // a refresh started elsewhere: follow it
        poll(m.providerId);
      }
    } catch (err) {
      if (!gone) error = errorText(err);
    } finally {
      if (!gone) loading = false;
    }
  }

  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveGuidePrefs({ view, filter }).catch(() => {});
    }, 500);
  }
  function setView(v: GuideView) {
    view = v;
    savePrefs();
  }
  function setFilter(f: string) {
    filter = f;
    savePrefs();
  }

  function poll(providerId: number) {
    pollTimer = setTimeout(async () => {
      let s: GuideStatus;
      try {
        s = await guideStatus(providerId);
      } catch (err) {
        if (!gone) {
          failure = errorText(err);
          refreshing = false;
        }
        return;
      }
      if (gone) return;
      if (s.state === 'running') return poll(providerId);
      refreshing = false;
      if (s.state === 'failed') failure = s.error ? `The guide couldn't be refreshed: ${s.error}` : "The guide couldn't be refreshed.";
      await loadMeta();
    }, 3000);
  }

  async function refresh() {
    if (!meta || meta.providerId === null) return;
    refreshing = true;
    failure = '';
    try {
      await refreshGuide(meta.providerId);
    } catch (err) {
      failure = errorText(err);
      refreshing = false;
      return;
    }
    poll(meta.providerId);
  }

  onMount(() => {
    void loadMeta();
  });
  onDestroy(() => {
    gone = true;
    clearTimeout(saveTimer);
    clearTimeout(pollTimer);
  });
</script>

<h1>Guide</h1>

{#if loading}
  <p class="muted" aria-busy="true">Loading…</p>
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else if meta && meta.providerId === null}
  <p>No provider yet. <a href="/settings/providers">Add one</a>.</p>
{:else if meta}
  {#if !hasGuide}
    <div class="empty">
      <p><strong>No TV guide yet</strong></p>
      <p class="muted">{refreshing ? 'Fetching the guide…' : 'Fetch it from your provider to see what is on.'}</p>
      {#if failure}<p class="error" role="alert">{failure}</p>{/if}
      <button type="button" class="button" disabled={refreshing} onclick={refresh}>Refresh guide</button>
    </div>
  {:else}
    <div class="views" role="tablist" aria-label="Guide view">
      <button type="button" role="tab" aria-selected={view === 'whatson'} class:on={view === 'whatson'} onclick={() => setView('whatson')}>What's on</button>
      <button type="button" role="tab" aria-selected={view === 'grid'} class:on={view === 'grid'} onclick={() => setView('grid')}>Grid</button>
    </div>
    <GuideChips chips={meta.chips} selected={filter} onSelect={setFilter} />
    {#if view === 'whatson'}
      <WhatsOn {filter} {chipLabel} />
    {:else}
      <GuideGrid {meta} {filter} />
    {/if}
  {/if}
{/if}

<style>
  .views {
    display: flex;
    padding: 3px;
    margin-bottom: 10px;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .views button {
    flex: 1;
    min-height: 38px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
    touch-action: manipulation;
  }
  .views button.on {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .empty {
    display: grid;
    gap: 6px;
    justify-items: center;
    text-align: center;
    padding: 40px 0;
  }
</style>
