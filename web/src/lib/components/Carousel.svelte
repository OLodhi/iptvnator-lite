<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { title: string; children: Snippet };
  let { title, children }: Props = $props();
</script>

<section class="carousel" aria-label={title}>
  <h2>{title}</h2>
  <div class="track">
    {@render children()}
  </div>
</section>

<style>
  .carousel {
    /* Bleed to the screen edges inside the padded <main>. */
    margin: 0 -16px;
  }
  h2 {
    margin: 20px 16px 8px;
  }
  .track {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0 10px 4px;
    scroll-snap-type: x proximity;
    scroll-padding: 0 10px;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .track::-webkit-scrollbar {
    display: none;
  }
  .track > :global(*) {
    flex: none;
    scroll-snap-align: start;
  }
</style>
