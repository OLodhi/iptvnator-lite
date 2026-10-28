import type { ProbeAudio, ProbeResult } from './probe.ts';
import { defaultAudioIndex } from './tracks.ts';

export type HlsPlan = {
  mode: 'hls';
  segment: 'ts' | 'fmp4';
  video: 'copy' | 'h264' | 'none';
  audio: { index: number; action: 'copy' | 'aac' } | null;
  deinterlace: boolean;
  tagHvc1: boolean;
  /**
   * AAC copied into fMP4 goes through FFmpeg's aac_adtstoasc: a live TS frames it as ADTS, which the MP4 muxer refuses.
   * Raw AAC (from an MKV, say) passes through unchanged. The filter takes AAC only.
   */
  adtsToAsc: boolean;
  /** A text subtitle stream, written as a WebVTT rendition beside the variant. */
  subtitle: { index: number } | null;
};

export type PlaybackPlan = { mode: 'direct' } | HlsPlan;

const DIRECT_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3']);
const COPY_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3']);

/** `requested` when it names a probed audio stream, otherwise English, the default track or the first. */
function chosenAudio(audio: ProbeAudio[], requested: number | undefined): ProbeAudio | undefined {
  const index = audio.some((a) => a.index === requested) ? requested : defaultAudioIndex(audio);
  return audio.find((a) => a.index === index);
}

export function choosePlan(
  probe: ProbeResult,
  ctx: {
    kind: 'live' | 'movie' | 'episode' | 'catchup';
    transcodeInterlaced: boolean;
    audioIndex?: number;
    subtitleIndex?: number | null;
  },
): PlaybackPlan {
  const video = probe.video;
  const firstAudio = probe.audio[0];
  // Only a file can be proxied as is: a live or catch-up stream always goes through FFmpeg.
  const file = ctx.kind === 'movie' || ctx.kind === 'episode';
  // Tracks are chosen for movies and episodes only. Live and catch-up play their first audio stream, as ever.
  const audio = file ? chosenAudio(probe.audio, ctx.audioIndex) : firstAudio;
  // Only a text track can become WebVTT; any other index is ignored.
  const subtitle = file ? probe.subtitles.find((s) => s.index === ctx.subtitleIndex && s.text) : undefined;

  const container = probe.formatName.includes('mp4') || probe.formatName.includes('mov');
  const videoOk = video !== null && (video.codec === 'h264' || (video.codec === 'hevc' && video.codecTag === 'hvc1'));
  const audioOk = firstAudio === undefined || DIRECT_AUDIO.has(firstAudio.codec);
  // A subtitle rendition needs FFmpeg. Direct play needs no audio choice: the player switches tracks itself.
  if (file && container && videoOk && audioOk && !subtitle) return { mode: 'direct' };

  const deinterlace = video !== null && video.interlaced && ctx.transcodeInterlaced;
  let videoAction: HlsPlan['video'];
  if (video === null) videoAction = 'none';
  else if (deinterlace) videoAction = 'h264';
  else if (video.codec === 'h264' || video.codec === 'hevc') videoAction = 'copy';
  else videoAction = 'h264';

  const hevcCopy = videoAction === 'copy' && video?.codec === 'hevc';
  return {
    mode: 'hls',
    segment: hevcCopy ? 'fmp4' : 'ts',
    video: videoAction,
    audio: audio ? { index: audio.index, action: COPY_AUDIO.has(audio.codec) ? 'copy' : 'aac' } : null,
    deinterlace,
    tagHvc1: hevcCopy,
    // AAC is always copied, so an AAC track in fMP4 is a copied one.
    adtsToAsc: hevcCopy && audio?.codec === 'aac',
    subtitle: subtitle ? { index: subtitle.index } : null,
  };
}
