<script lang="ts">
  import type { MediaTrack } from '@tv/shared';
  import ActionSheet from '../ActionSheet.svelte';

  type Props = {
    open: boolean;
    kind: 'audio' | 'subtitles';
    tracks: MediaTrack[];
    selected: number | null;
    onPick: (index: number | null) => void;
    onClose: () => void;
  };

  let { open, kind, tracks, selected, onPick, onClose }: Props = $props();

  const actions = $derived([
    ...(kind === 'subtitles' ? [{ key: 'off', label: 'Off', selected: selected === null, run: () => onPick(null) }] : []),
    ...tracks.map((t) => ({
      key: t.index,
      label: t.available ? t.label : `${t.label} (not supported on this device)`,
      disabled: !t.available,
      selected: t.index === selected,
      run: () => onPick(t.index),
    })),
  ]);
</script>

<ActionSheet {open} title={kind === 'audio' ? 'Audio' : 'Subtitles'} {actions} {onClose} />
