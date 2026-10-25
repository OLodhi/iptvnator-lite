<script module lang="ts">
  const episodes = (n: number) => `${n} ${n === 1 ? 'episode' : 'episodes'}`;

  /** How much of a season is watched: "8 episodes · watched", "2 of 10 watched", or "1 episode" before any. */
  export function seasonSummary(count: number, watched: number): string {
    if (count > 0 && watched >= count) return `${episodes(count)} · watched`;
    if (watched > 0) return `${watched} of ${count} watched`;
    return episodes(count);
  }
</script>

<script lang="ts">
  import type { SeasonDetail } from '@tv/shared';
  import ActionSheet from '../ActionSheet.svelte';

  type Props = {
    open: boolean;
    /** In the order they are listed. */
    seasons: SeasonDetail[];
    /** The season on show. */
    selected: number;
    watchedCount: (s: SeasonDetail) => number;
    onPick: (season: number) => void;
    onClose: () => void;
  };

  let { open, seasons, selected, watchedCount, onPick, onClose }: Props = $props();

  const actions = $derived(
    seasons.map((s) => ({
      key: s.season,
      label: `${s.name} · ${seasonSummary(s.episodes.length, watchedCount(s))}`,
      selected: s.season === selected,
      run: () => onPick(s.season),
    })),
  );
</script>

<ActionSheet {open} title="Choose a season" {actions} {onClose} />
