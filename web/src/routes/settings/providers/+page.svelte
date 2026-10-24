<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { AddProviderRequest, ImportResult, ProviderSummary, SyncStatus } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';
  import { importIptvnator, refresh } from '$lib/me';
  import { firstProvider } from '$lib/provider';

  let provider = $state<ProviderSummary | null>(null);
  let loaded = $state(false);
  let imported = $state<ImportResult | null>(null);
  let importing = $state(false);
  let refreshing = $state(false);

  onMount(async () => {
    try {
      provider = (await firstProvider()) ?? null;
    } catch {
      // fall back to the add form
    }
    loaded = true;
  });

  const fail = (err: unknown) => (err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.');

  async function refreshNow() {
    if (!provider) return;
    refreshing = true;
    error = '';
    sync = null;
    try {
      await refresh(provider.id);
      poll(provider.id);
    } catch (err) {
      error = fail(err);
    } finally {
      refreshing = false;
    }
  }

  async function chooseFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow choosing the same file again
    if (!file || !provider) return;
    importing = true;
    error = '';
    imported = null;
    try {
      imported = await importIptvnator(provider.id, file);
    } catch (err) {
      error = fail(err);
    } finally {
      importing = false;
    }
  }

  let serverUrl = $state('');
  let username = $state('');
  let password = $state('');
  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  let sync = $state<SyncStatus | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopPolling() {
    clearInterval(timer);
    timer = undefined;
  }
  onDestroy(stopPolling);

  const total = (kind: 'live' | 'movie' | 'series') => sync?.result?.[kind]?.items ?? 0;

  function poll(id: number) {
    stopPolling();
    const tick = async () => {
      try {
        sync = await api<SyncStatus>(`/api/providers/${id}/sync`);
        if (sync.state !== 'running') stopPolling();
      } catch {
        // keep trying; the server may be busy
      }
    };
    void tick();
    timer = setInterval(tick, 1000);
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    sync = null;
    try {
      const body: AddProviderRequest = { kind: 'xtream', serverUrl: serverUrl.trim(), username: username.trim(), password };
      if (name.trim()) body.name = name.trim();
      const added = await api<ProviderSummary>('/api/providers', { method: 'POST', body: JSON.stringify(body) });
      password = '';
      provider = added;
      poll(added.id);
    } catch (err) {
      error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    } finally {
      busy = false;
    }
  }
</script>

{#if provider}
  <h1>Providers</h1>
  <div class="card">
    <p class="pname">{provider.name}</p>
    <p class="muted">
      {provider.lastSyncedAt ? `Updated ${new Date(provider.lastSyncedAt).toLocaleString()}` : 'Not loaded yet'}
    </p>
    <button type="button" class="primary" disabled={refreshing || sync?.state === 'running'} onclick={refreshNow}>
      {refreshing || sync?.state === 'running' ? 'Refreshing…' : 'Refresh now'}
    </button>
    <p class="muted"><a href="/settings/categories">Choose categories</a></p>
  </div>

  <h2>Import from IPTVnator</h2>
  <div class="card">
    <p class="muted">
      On your PC this is in your user folder under <code>.iptvnator\databases\iptvnator.db</code>.
      Quit IPTVnator first so its latest changes are saved into the file.
    </p>
    <label class="filebtn">
      <span>{importing ? 'Importing…' : 'Choose iptvnator.db'}</span>
      <input type="file" accept=".db,.sqlite,application/octet-stream" disabled={importing} onchange={chooseFile} />
    </label>
    {#if imported}
      <p role="status">
        Matched {imported.categoriesMatched} categories, hid {imported.hiddenApplied}, imported {imported.favouritesImported}
        {imported.favouritesImported === 1 ? 'favourite' : 'favourites'}.
      </p>
    {/if}
  </div>
{:else if loaded}
  <h1>Add your provider</h1>

<form onsubmit={submit}>
  <label>Server address
    <!-- Text, not url: bare hosts like 192.168.1.5:8080 are fine (the server normalises them). -->
    <input
      type="text"
      inputmode="url"
      bind:value={serverUrl}
      placeholder="http://example.com:8080"
      required
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
    />
  </label>
  <label>Username
    <input bind:value={username} required autocapitalize="off" autocorrect="off" autocomplete="username" />
  </label>
  <label>Password
    <input type="password" bind:value={password} required autocomplete="current-password" />
  </label>
  <label>Name (optional)
    <input bind:value={name} />
  </label>
  <button class="primary" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Add provider'}</button>
</form>
{/if}

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

{#if sync}
  {#if sync.state === 'running'}
    <h2>Loading your channels…</h2>
    <p>Live {total('live')} · Movies {total('movie')} · Series {total('series')}</p>
  {:else if sync.state === 'idle'}
    <h2>Ready</h2>
    <p>Live {total('live')} · Movies {total('movie')} · Series {total('series')}</p>
    <a class="button" href="/browse/live">Go to Live</a>
  {:else}
    <p class="error" role="alert">Loading your channels didn't finish. Please try again.</p>
  {/if}
{/if}

<style>
  .card {
    display: grid;
    gap: 10px;
    padding: 16px;
    border-radius: 12px;
    background: var(--surface);
  }
  .card p {
    margin: 0;
  }
  .pname {
    font-weight: 600;
    font-size: 1.1rem;
  }
  .filebtn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--row-height);
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 1rem;
    cursor: pointer;
  }
  .filebtn input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
</style>
