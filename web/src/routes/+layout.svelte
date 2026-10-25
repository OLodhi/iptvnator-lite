<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';

  let { children } = $props();

  const tabs = [
    { href: '/browse/live', label: 'Live' },
    { href: '/browse/movie', label: 'Movies' },
    { href: '/browse/series', label: 'Series' },
    { href: '/search', label: 'Search' },
    { href: '/settings', label: 'Settings' }
  ];

  // The watch page has its own Back, and fills the screen when held sideways.
  const watching = $derived(page.url.pathname.startsWith('/watch'));
</script>

<main class:watching>
  {@render children()}
</main>

{#if !watching}
  <nav class="tabbar" aria-label="Sections">
    {#each tabs as tab}
      <a href={tab.href} aria-current={page.url.pathname.startsWith(tab.href) ? 'page' : undefined}>{tab.label}</a>
    {/each}
  </nav>
{/if}

<style>
  main.watching {
    padding: 0 0 env(safe-area-inset-bottom);
  }
</style>
