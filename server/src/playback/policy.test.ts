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
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false, subtitle: null }],
  ['mp4 h264 aac movie', probe(MP4, {}, aac), 'movie', false, { mode: 'direct' }],
  ['mp4 h264 aac episode', probe(MP4, {}, aac), 'episode', false, { mode: 'direct' }],
  ['mp4 h264 aac catch-up is never direct', probe(MP4, {}, aac), 'catchup', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false, subtitle: null }],
  ['mp4 h264 aac live', probe(MP4, {}, aac), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false, subtitle: null }],
  ['mpegts mpeg2 mp2 live', probe('mpegts', { codec: 'mpeg2video' }, [{ codec: 'mp2' }]), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'h264', audio: { index: 1, action: 'aac' }, deinterlace: false, tagHvc1: false, subtitle: null }],
  ['mkv hevc hev1 movie', probe(MKV, { codec: 'hevc', codecTag: 'hev1' }, aac), 'movie', false,
    { mode: 'hls', segment: 'fmp4', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: true, subtitle: null }],
  ['mkv hevc no tag movie', probe(MKV, { codec: 'hevc' }, aac), 'movie', false,
    { mode: 'hls', segment: 'fmp4', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: true, subtitle: null }],
  ['mp4 hevc hvc1 movie', probe(MP4, { codec: 'hevc', codecTag: 'hvc1' }, aac), 'movie', false, { mode: 'direct' }],
  ['mp4 hevc hev1 movie', probe(MP4, { codec: 'hevc', codecTag: 'hev1' }, aac), 'movie', false,
    { mode: 'hls', segment: 'fmp4', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: true, subtitle: null }],
  ['mp4 h264 dts movie is not direct', probe(MP4, {}, [{ codec: 'dts' }]), 'movie', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'aac' }, deinterlace: false, tagHvc1: false, subtitle: null }],
  ['mp4 h264 no audio movie', probe(MP4, {}, []), 'movie', false, { mode: 'direct' }],
  ['interlaced live, no transcode', probe('mpegts', { interlaced: true }, aac), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false, subtitle: null }],
  ['interlaced live, transcode', probe('mpegts', { interlaced: true }, aac), 'live', true,
    { mode: 'hls', segment: 'ts', video: 'h264', audio: { index: 1, action: 'copy' }, deinterlace: true, tagHvc1: false, subtitle: null }],
  ['interlaced hevc, transcode -> ts h264', probe(MKV, { codec: 'hevc', interlaced: true }, aac), 'movie', true,
    { mode: 'hls', segment: 'ts', video: 'h264', audio: { index: 1, action: 'copy' }, deinterlace: true, tagHvc1: false, subtitle: null }],
  ['mkv h264 dts movie', probe(MKV, {}, [{ codec: 'dts', index: 2 }, { codec: 'ac3', index: 3 }]), 'movie', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: { index: 2, action: 'aac' }, deinterlace: false, tagHvc1: false, subtitle: null }],
  ['mpegts h264 no audio live', probe('mpegts', {}, []), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'copy', audio: null, deinterlace: false, tagHvc1: false, subtitle: null }],
  ['mpegts audio only live', probe('mpegts', null, aac), 'live', false,
    { mode: 'hls', segment: 'ts', video: 'none', audio: { index: 1, action: 'copy' }, deinterlace: false, tagHvc1: false, subtitle: null }],
];

test.each(cases)('choosePlan: %s', (_name, p, kind, transcodeInterlaced, expected) => {
  expect(choosePlan(p, { kind, transcodeInterlaced })).toEqual(expected);
});

/** Dutch audio (the default disposition) then English; English then Dutch text subtitles, and an English PGS track. */
function multiTrack(formatName: string): ProbeResult {
  const track = { codec: 'aac', channels: 2, title: null };
  const text = { codec: 'subrip', title: null, isDefault: false, forced: false, text: true };
  return {
    ...probe(formatName, {}, []),
    audio: [
      { ...track, index: 1, language: 'nld', isDefault: true },
      { ...track, index: 2, language: 'eng', isDefault: false },
    ],
    subtitles: [
      { ...text, index: 3, language: 'eng' },
      { ...text, index: 4, language: 'nld' },
      { ...text, index: 5, language: 'eng', codec: 'hdmv_pgs_subtitle', text: false },
    ],
  };
}

test('a requested subtitle forces HLS', () => {
  const mp4 = multiTrack(MP4);
  expect(choosePlan(mp4, { kind: 'movie', transcodeInterlaced: false })).toEqual({ mode: 'direct' });
  expect(choosePlan(mp4, { kind: 'movie', transcodeInterlaced: false, subtitleIndex: null })).toEqual({ mode: 'direct' });
  // In direct play the player switches audio itself, so a chosen audio track keeps it direct.
  expect(choosePlan(mp4, { kind: 'episode', transcodeInterlaced: false, audioIndex: 1 })).toEqual({ mode: 'direct' });
  expect(choosePlan(mp4, { kind: 'episode', transcodeInterlaced: false, subtitleIndex: 4 })).toEqual({
    mode: 'hls',
    segment: 'ts',
    video: 'copy',
    audio: { index: 2, action: 'copy' },
    deinterlace: false,
    tagHvc1: false,
    subtitle: { index: 4 },
  });
});

test('audioIndex selects that stream; an unknown index falls back to the default rule', () => {
  const mkv = multiTrack(MKV);
  const audioOf = (audioIndex?: number) => {
    const plan = choosePlan(mkv, { kind: 'movie', transcodeInterlaced: false, audioIndex });
    return plan.mode === 'hls' ? plan.audio : 'direct';
  };
  expect(audioOf()).toEqual({ index: 2, action: 'copy' }); // English, though Dutch is the default disposition
  expect(audioOf(1)).toEqual({ index: 1, action: 'copy' });
  expect(audioOf(0)).toEqual({ index: 2, action: 'copy' }); // the video stream
  expect(audioOf(3)).toEqual({ index: 2, action: 'copy' }); // a subtitle stream
  expect(audioOf(9)).toEqual({ index: 2, action: 'copy' });
});

test('a picture subtitle index is ignored', () => {
  const plan = choosePlan(multiTrack(MKV), { kind: 'movie', transcodeInterlaced: false, subtitleIndex: 5 });
  expect(plan).toMatchObject({ mode: 'hls', subtitle: null });
  expect(choosePlan(multiTrack(MKV), { kind: 'movie', transcodeInterlaced: false, subtitleIndex: 2 })).toMatchObject({ subtitle: null });
  expect(choosePlan(multiTrack(MKV), { kind: 'movie', transcodeInterlaced: false, subtitleIndex: 3 })).toMatchObject({ subtitle: { index: 3 } });
  // Nothing to convert: an MP4 that would otherwise play directly still does.
  expect(choosePlan(multiTrack(MP4), { kind: 'movie', transcodeInterlaced: false, subtitleIndex: 5 })).toEqual({ mode: 'direct' });
});

test('live and catch-up have no track choices: the first audio stream, and no subtitles', () => {
  for (const kind of ['live', 'catchup'] as const) {
    const plan = choosePlan(multiTrack('mpegts'), { kind, transcodeInterlaced: false, audioIndex: 2, subtitleIndex: 3 });
    expect(plan, kind).toMatchObject({ mode: 'hls', audio: { index: 1, action: 'copy' }, subtitle: null });
  }
});
