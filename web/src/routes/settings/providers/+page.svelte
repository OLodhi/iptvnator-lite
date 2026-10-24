<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { AddProviderRequest, ProviderSummary, SyncStatus } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { messageFor } from '$lib/messages';

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
      const provider = await api<ProviderSummary>('/api/providers', { method: 'POST', body: JSON.stringify(body) });
      password = '';
      poll(provider.id);
    } catch (err) {
      error = err instanceof ApiClientError ? messageFor(err) : 'Something went wrong. Please try again.';
    } finally {
      busy = false;
    }
  }
</script>

<h1>Add your provider</h1>

<form onsubmit={submit}>
  <label>Server address
    <input type="url" bind:value={serverUrl} placeholder="http://example.com:8080" required autocapitalize="off" autocorrect="off" />
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
