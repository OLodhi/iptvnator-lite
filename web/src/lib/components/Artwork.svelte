<script lang="ts">
  import { hueFor, initials } from '$lib/browseModel';

  type Props = { name: string; src: string | null; fit?: 'contain' | 'cover' };
  let { name, src, fit = 'cover' }: Props = $props();

  let failed = $state(false);
  $effect(() => {
    src; // a new source gets a fresh chance
    failed = false;
  });
</script>

{#if src && !failed}
  <img {src} alt="" loading="lazy" decoding="async" class={fit} onerror={() => (failed = true)} />
{:else}
  <span class="tile" style:--hue={hueFor(name)} aria-hidden="true">{initials(name)}</span>
{/if}

<style>
  img,
  .tile {
    display: block;
    width: 100%;
    height: 100%;
  }
  img {
    background: var(--surface-2);
  }
  img.cover {
    object-fit: cover;
  }
  img.contain {
    object-fit: contain;
  }
  .tile {
    display: grid;
    place-items: center;
    font-weight: 700;
    font-size: 1.1rem;
    letter-spacing: 0.04em;
    color: hsl(var(--hue) 70% 85%);
    background: linear-gradient(145deg, hsl(var(--hue) 35% 24%), hsl(var(--hue) 40% 14%));
  }
</style>
