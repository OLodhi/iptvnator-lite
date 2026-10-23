import type { ProbeResult } from './probe.ts';

export type HlsPlan = {
  mode: 'hls';
  segment: 'ts' | 'fmp4';
  video: 'copy' | 'h264' | 'none';
  audio: { index: number; action: 'copy' | 'aac' } | null;
  deinterlace: boolean;
  tagHvc1: boolean;
};

export type PlaybackPlan = { mode: 'direct' } | HlsPlan;

const DIRECT_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3']);
const COPY_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3']);

export function choosePlan(
  probe: ProbeResult,
  ctx: { kind: 'live' | 'movie' | 'episode'; transcodeInterlaced: boolean },
): PlaybackPlan {
  const video = probe.video;
  const firstAudio = probe.audio[0];

  const container = probe.formatName.includes('mp4') || probe.formatName.includes('mov');
  const videoOk = video !== null && (video.codec === 'h264' || (video.codec === 'hevc' && video.codecTag === 'hvc1'));
  const audioOk = firstAudio === undefined || DIRECT_AUDIO.has(firstAudio.codec);
  if (ctx.kind !== 'live' && container && videoOk && audioOk) return { mode: 'direct' };

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
    audio: firstAudio ? { index: firstAudio.index, action: COPY_AUDIO.has(firstAudio.codec) ? 'copy' : 'aac' } : null,
    deinterlace,
    tagHvc1: hevcCopy,
  };
}
