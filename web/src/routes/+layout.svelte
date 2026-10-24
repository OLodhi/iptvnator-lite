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
</script>

<main>
  {@render children()}
</main>

<nav class="tabbar" aria-label="Sections">
  {#each tabs as tab}
    <a href={tab.href} aria-current={page.url.pathname.startsWith(tab.href) ? 'page' : undefined}>{tab.label}</a>
  {/each}
</nav>
