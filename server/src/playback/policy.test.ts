import { expect, test } from 'vitest';
import { choosePlan } from './policy.ts';
import type { ProbeResult } from './probe.ts';

type V = NonNullable<ProbeResult['video']>;

function probe(
  formatName: string,
  video: Partial<V> | null,
  audio: { codec: string; index?: number }[],
): ProbeResult {
  return {
    formatName,
    durationSec: 60,
    video: video && { codec: 'h264', codecTag: null, width: 640, height: 360, interlaced: false, fieldOrder: null, ...video },
    audio: audio.map((a, i) => ({ index: a.index ?? i + 1, codec: a.codec, channels: 2, language: null, title: null, isDefault: false })),
    subtitles: [],
  };
}

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
const MKV = 'matroska,webm';
const aac = [{ codec: 'aac' }];

const cases: [string, ProbeResult, 'live' | 'movie' | 'episode' | 'catchup', boolean, unknown][] = [
  ['mkv h264 aac movie', probe(MKV, {}, aac), 'movie', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false }],
  ['mp4 h264 aac movie', probe(MP4, {}, aac), 'movie', false, { mode: 'direct' }],
  ['mp4 h264 aac episode', probe(MP4, {}, aac), 'episode', false, { mode: 'direct' }],
  ['mp4 h264 aac catch-up is never direct', probe(MP4, {}, aac), 'catchup', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false }],
  ['mp4 h264 aac live', probe(MP4, {}, aac), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false }],
  ['mpegts mpeg2 mp2 live', probe('mpegts', { codec: 'mpeg2video' }, [{ codec: 'mp2' }]), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'h264', audio: { index: 1, action: 'aac' }, deinterlace: false, tagHvc1: false }],
  ['mkv hevc hev1 movie', probe(MKV, { codec: 'hevc', codecTag: 'hev1' }, aac), 'movie', false,
    { mode: 'hls', segment: 'fmp4', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: true }],
  ['mkv hevc no tag movie', probe(MKV, { codec: 'hevc' }, aac), 'movie', false,
    { mode: 'hls', segment: 'fmp4', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: true }],
  ['mp4 hevc hvc1 movie', probe(MP4, { codec: 'hevc', codecTag: 'hvc1' }, aac), 'movie', false, { mode: 'direct' }],
  ['mp4 hevc hev1 movie', probe(MP4, { codec: 'hevc', codecTag: 'hev1' }, aac), 'movie', false,
    { mode: 'hls', segment: 'fmp4', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: true }],
  ['mp4 h264 dts movie is not direct', probe(MP4, {}, [{ codec: 'dts' }]), 'movie', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'aac' }, deinterlace: false, tagHvc1: false }],
  ['mp4 h264 no audio movie', probe(MP4, {}, []), 'movie', false, { mode: 'direct' }],
  ['interlaced live, no transcode', probe('mpegts', { interlaced: true }, aac), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false }],
  ['interlaced live, transcode', probe('mpegts', { interlaced: true }, aac), 'live', true,
    { mode: 'hls', segment: 'ts', video: 'h264', audio: { index: 1, action: 'copy' }, deinterlace: true, tagHvc1: false }],
  ['interlaced hevc, transcode -> ts h264', probe(MKV, { codec: 'hevc', interlaced: true }, aac), 'movie', true,
    { mode: 'hls', segment: 'ts', video: 'h264', audio: { index: 1, action: 'copy' }, deinterlace: true, tagHvc1: false }],
  ['mkv h264 dts movie', probe(MKV, {}, [{ codec: 'dts', index: 2 }, { codec: 'ac3', index: 3 }]), 'movie', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 2, action: 'aac' }, deinterlace: false, tagHvc1: false }],
  ['mpegts h264 no audio live', probe('mpegts', {}, []), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: null, deinterlace: false, tagHvc1: false }],
  ['mpegts audio only live', probe('mpegts', null, aac), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'none', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false }],
];

test.each(cases)('choosePlan: %s', (_name, p, kind, transcodeInterlaced, expected) => {
  expect(choosePlan(p, { kind, transcodeInterlaced })).toEqual(expected);
});
