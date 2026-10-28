import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { buildFfmpegArgs } from './ffmpegArgs.ts';
import type { HlsPlan } from './policy.ts';

const copyTs: HlsPlan = {
  mode: 'hls',
  segment: 'ts',
  video: 'copy',
  audio: { index: 1, action: 'copy' },
  deinterlace: false,
  tagHvc1: false,
  adtsToAsc: false,
  subtitle: null,
};

function has(args: string[], ...seq: string[]): void {
  const found = args.some((_, i) => seq.every((s, j) => args[i + j] === s));
  expect(found, `expected ${seq.join(' ')} in ${args.join(' ')}`).toBe(true);
}

const base = { url: 'http://h/live/u/p/1.m3u8', userAgent: 'TiviMate/4.7.0', live: true, startAtSec: 0, outDir: 'O', startNumber: 0 };

test('copy plan for live writes a 10-minute sliding window of ts segments', () => {
  const a = buildFfmpegArgs({ ...base, plan: copyTs });
  expect(a.slice(0, 5)).toEqual(['-hide_banner', '-loglevel', 'warning', '-nostdin', '-fflags']);
  has(a, '-fflags', '+genpts+discardcorrupt');
  has(a, '-user_agent', 'TiviMate/4.7.0');
  has(a, '-reconnect', '1');
  has(a, '-reconnect_streamed', '1');
  has(a, '-reconnect_on_network_error', '1');
  has(a, '-reconnect_delay_max', '10');
  has(a, '-i', 'http://h/live/u/p/1.m3u8');
  has(a, '-c:v', 'copy');
  has(a, '-c:a', 'copy');
  has(a, '-f', 'hls');
  has(a, '-hls_time', '3');
  has(a, '-hls_init_time', '1');
  has(a, '-hls_list_size', '200');
  // omit_endlist (R31): an exiting FFmpeg must not mark the live playlist finished while it is relaunched.
  has(a, '-hls_flags', 'delete_segments+independent_segments+omit_endlist');
  has(a, '-hls_segment_type', 'mpegts');
  has(a, '-hls_segment_filename', 'O/seg_%05d.ts');
  expect(a.at(-1)).toBe('O/index.m3u8');
  expect(a).not.toContain('-ss');
  expect(a).not.toContain('-start_number');
  expect(a.indexOf('-user_agent')).toBeLessThan(a.indexOf('-i'));
});

test('restarted live sessions continue numbering with a discontinuity', () => {
  const a = buildFfmpegArgs({ ...base, plan: copyTs, startNumber: 42 });
  has(a, '-start_number', '42');
  has(a, '-hls_flags', 'delete_segments+independent_segments+omit_endlist+discont_start');
});

test('vod starts at an offset before the input and writes an event playlist', () => {
  const a = buildFfmpegArgs({ ...base, url: 'http://h/movie/u/p/1.mkv', plan: copyTs, live: false, startAtSec: 1800 });
  has(a, '-ss', '1800');
  expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
  has(a, '-hls_playlist_type', 'event');
  has(a, '-hls_list_size', '0');
  expect(a.join(' ')).not.toContain('delete_segments');
  expect(a.join(' ')).not.toContain('omit_endlist'); // a finished title does end
  has(a, '-hls_flags', 'independent_segments');
});

test('h264 transcode uses fixed GOP and optional deinterlace', () => {
  const plan: HlsPlan = { ...copyTs, video: 'h264' };
  const a = buildFfmpegArgs({ ...base, plan });
  has(a, '-c:v', 'libx264');
  has(a, '-preset', 'veryfast');
  has(a, '-crf', '21');
  has(a, '-pix_fmt', 'yuv420p');
  has(a, '-g', '48');
  has(a, '-sc_threshold', '0');
  expect(a).not.toContain('-vf');
  const d = buildFfmpegArgs({ ...base, plan: { ...plan, deinterlace: true } });
  has(d, '-vf', 'yadif=mode=0');
});

test('hevc copy uses fmp4 segments and the hvc1 tag', () => {
  const plan: HlsPlan = { ...copyTs, segment: 'fmp4', tagHvc1: true };
  const a = buildFfmpegArgs({ ...base, plan });
  has(a, '-tag:v', 'hvc1');
  has(a, '-hls_segment_type', 'fmp4');
  has(a, '-hls_fmp4_init_filename', 'init.mp4');
  has(a, '-hls_segment_filename', 'O/seg_%05d.m4s');
});

test('aac copied into fmp4 is unwrapped from its ADTS frames', () => {
  const plan: HlsPlan = { ...copyTs, segment: 'fmp4', tagHvc1: true, adtsToAsc: true };
  has(buildFfmpegArgs({ ...base, plan }), '-bsf:a', 'aac_adtstoasc');
  expect(buildFfmpegArgs({ ...base, plan: copyTs })).not.toContain('aac_adtstoasc');
});

test('aac audio transcode is stereo 160k and maps the chosen stream', () => {
  const a = buildFfmpegArgs({ ...base, plan: { ...copyTs, audio: { index: 2, action: 'aac' } } });
  has(a, '-map', '0:2');
  has(a, '-c:a', 'aac');
  has(a, '-b:a', '160k');
  has(a, '-ac', '2');
  has(a, '-map', '0:v:0');
});

test('audio maps the chosen stream', () => {
  const a = buildFfmpegArgs({ ...base, live: false, plan: { ...copyTs, audio: { index: 2, action: 'copy' } } });
  has(a, '-map', '0:v:0');
  has(a, '-map', '0:2');
  expect(a.filter((x) => x === '-map')).toHaveLength(2);
});

const vod = { ...base, url: 'http://h/movie/u/p/5.mkv', live: false };

test('a subtitle adds webvtt and a master playlist', () => {
  const plan: HlsPlan = { ...copyTs, audio: { index: 2, action: 'copy' }, subtitle: { index: 3 } };
  const a = buildFfmpegArgs({ ...vod, plan });
  has(a, '-map', '0:v:0');
  has(a, '-map', '0:2');
  has(a, '-map', '0:3');
  has(a, '-c:s', 'webvtt');
  has(a, '-master_pl_name', 'master.m3u8');
  has(a, '-var_stream_map', 'v:0,a:0,s:0,sgroup:subs');
  // FFmpeg's %v names each variant's files: stream_0.m3u8, seg_0_00000.ts, and the subtitles' stream_0_vtt.m3u8.
  has(a, '-hls_segment_filename', 'O/seg_%v_%05d.ts');
  expect(a.at(-1)).toBe('O/stream_%v.m3u8');
  // FFmpeg writes a variant into the master only once it knows a bit rate, which a copied MKV stream lacks:
  // nominal rates label the copied streams, so the master names the variant from its first write.
  has(a, '-b:v', '8M');
  has(a, '-b:a', '192k');
  // No X-TIMESTAMP-MAP in FFmpeg's WebVTT segments, so cues are read against MPEG-TS time 0: no 1.4 s mux offset.
  has(a, '-muxdelay', '0');
  expect(a.indexOf('-master_pl_name')).toBeGreaterThan(a.indexOf('-f'));

  const audioOnly = buildFfmpegArgs({ ...vod, plan: { ...plan, video: 'none' } });
  has(audioOnly, '-var_stream_map', 'a:0,s:0,sgroup:subs');
  expect(audioOnly).not.toContain('-b:v');

  // Encoded streams already have their rates (and libx264's CRF must not be overridden).
  const encoded = buildFfmpegArgs({ ...vod, plan: { ...plan, video: 'h264', audio: { index: 2, action: 'aac' } } });
  expect(encoded).not.toContain('-b:v');
  expect(encoded.filter((x) => x === '-b:a')).toHaveLength(1);
  has(encoded, '-b:a', '160k');

  const hevc = buildFfmpegArgs({ ...vod, plan: { ...plan, segment: 'fmp4', tagHvc1: true } });
  has(hevc, '-hls_fmp4_init_filename', 'init.mp4'); // a single variant's init file keeps its name
  has(hevc, '-hls_segment_filename', 'O/seg_%v_%05d.m4s');
});

test('no subtitle keeps index.m3u8', () => {
  for (const plan of [copyTs, { ...copyTs, segment: 'fmp4' as const, tagHvc1: true }]) {
    const a = buildFfmpegArgs({ ...vod, plan });
    expect(a.at(-1)).toBe('O/index.m3u8');
    for (const flag of ['-c:s', '-master_pl_name', '-var_stream_map', '-b:v', '-muxdelay']) expect(a).not.toContain(flag);
    expect(a.join(' ')).not.toContain('%v');
  }
});

test('missing video or audio is dropped explicitly', () => {
  const a = buildFfmpegArgs({ ...base, plan: { ...copyTs, video: 'none', audio: null } });
  expect(a).toContain('-vn');
  expect(a).toContain('-an');
  expect(a).not.toContain('-map');
});

test('file inputs get no reconnect flags', () => {
  const a = buildFfmpegArgs({ ...base, url: '/tmp/x.ts', plan: copyTs });
  expect(a.some((x) => x.startsWith('-reconnect'))).toBe(false);
  has(a, '-i', '/tmp/x.ts');
});

test('HLS inputs open one connection at a time (http_multiple 0, before -i)', () => {
  for (const url of ['http://h/live/u/p/1.m3u8', 'http://h/live/u/p/1.M3U8', 'http://h/live/u/p/1.m3u8?token=x']) {
    const a = buildFfmpegArgs({ ...base, url, plan: copyTs });
    has(a, '-http_multiple', '0');
    expect(a.indexOf('-http_multiple'), url).toBeLessThan(a.indexOf('-i'));
  }
});

test('a .m3u8 URL that serves something other than HLS gets no http_multiple (FFmpeg rejects the option)', () => {
  const url = 'http://h/live/u/p/2.m3u8';
  expect(buildFfmpegArgs({ ...base, url, plan: copyTs, inputFormat: 'mpegts' })).not.toContain('-http_multiple');
  has(buildFfmpegArgs({ ...base, url, plan: copyTs, inputFormat: 'hls,applehttp' }), '-http_multiple', '0');
});

test('other inputs get no http_multiple', () => {
  for (const url of ['http://h/live/u/p/1.ts', 'http://h/movie/u/p/1.mkv', 'http://h/movie/u/p/1.mp4', '/tmp/x.ts', '/tmp/x.m3u8']) {
    expect(buildFfmpegArgs({ ...base, url, plan: copyTs }), url).not.toContain('-http_multiple');
  }
});

const ffmpeg = process.env.TV_FFMPEG_PATH;

test.skipIf(!ffmpeg)('real ffmpeg writes the fmp4 init segment inside outDir and references it relatively', () => {
  const input = path.resolve(import.meta.dirname, '../../../tools/fake-xtream/media/hevc.mkv');
  const outDir = mkdtempSync(path.join(tmpdir(), 'tv-ffargs-'));
  const strayInit = path.join(process.cwd(), 'init.mp4');
  try {
    const plan: HlsPlan = { ...copyTs, segment: 'fmp4', tagHvc1: true, audio: null };
    const args = buildFfmpegArgs({ ...base, url: input, plan, live: false, outDir });
    const r = spawnSync(ffmpeg!, args, { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(outDir, 'init.mp4'))).toBe(true);
    expect(existsSync(strayInit)).toBe(false);
    const playlist = readFileSync(path.join(outDir, 'index.m3u8'), 'utf8');
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    const segs = playlist.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'));
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) expect(s).toMatch(/^seg_\d{5}\.m4s$/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test.skipIf(!ffmpeg)('real ffmpeg copies the ADTS AAC of a TS source into fmp4 segments', () => {
  const mkv = path.resolve(import.meta.dirname, '../../../tools/fake-xtream/media/hevc.mkv');
  const outDir = mkdtempSync(path.join(tmpdir(), 'tv-ffargs-'));
  try {
    // A live channel's TS frames its AAC as ADTS, which the MP4 muxer refuses unwrapped ("Malformed AAC bitstream").
    const input = path.join(outDir, 'in.ts');
    const remux = spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-i', mkv, '-c', 'copy', '-f', 'mpegts', input], { encoding: 'utf8', windowsHide: true });
    expect(remux.status, remux.stderr).toBe(0);
    const plan: HlsPlan = { ...copyTs, segment: 'fmp4', tagHvc1: true, adtsToAsc: true };
    const r = spawnSync(ffmpeg!, buildFfmpegArgs({ ...base, url: input, plan, live: false, outDir }), { encoding: 'utf8', windowsHide: true });
    expect(r.status, r.stderr).toBe(0);
    const segs = readFileSync(path.join(outDir, 'index.m3u8'), 'utf8').split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'));
    expect(segs.length).toBeGreaterThan(0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test.skipIf(!ffmpeg)('real ffmpeg writes a master naming the variant and a WebVTT rendition, all inside outDir', () => {
  const input = path.resolve(import.meta.dirname, '../../../tools/fake-xtream/media/multi.mkv'); // eng audio 2, eng subtitles 3
  const outDir = mkdtempSync(path.join(tmpdir(), 'tv-ffargs-'));
  const listed = (name: string) =>
    readFileSync(path.join(outDir, name), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l !== '' && !l.startsWith('#'));
  try {
    const plan: HlsPlan = { ...copyTs, audio: { index: 2, action: 'copy' }, subtitle: { index: 3 } };
    const r = spawnSync(ffmpeg!, buildFfmpegArgs({ ...base, url: input, plan, live: false, outDir }), { encoding: 'utf8', windowsHide: true });
    expect(r.status, r.stderr).toBe(0);
    // FFmpeg warns this when its first master write had to leave the variant out.
    expect(r.stderr).not.toContain('Bandwidth info not available');
    const master = readFileSync(path.join(outDir, 'master.m3u8'), 'utf8');
    expect(master).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"');
    expect(master).toContain('URI="stream_0_vtt.m3u8"');
    expect(master).toMatch(/#EXT-X-STREAM-INF:.*SUBTITLES="subs"\r?\nstream_0\.m3u8/);
    for (const s of listed('stream_0.m3u8')) expect(s).toMatch(/^seg_0_\d{5}\.ts$/);
    const vtts = listed('stream_0_vtt.m3u8');
    expect(vtts.length).toBeGreaterThan(0);
    for (const s of vtts) expect(s).toMatch(/^stream_0\d+\.vtt$/);
    expect(readFileSync(path.join(outDir, vtts[0]!), 'utf8')).toMatch(/^WEBVTT[\s\S]*English 1/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test.skipIf(!ffmpeg)('real ffmpeg leaves no ENDLIST in a live playlist when its input ends', () => {
  const input = path.resolve(import.meta.dirname, '../../../tools/fake-xtream/media/raw.ts'); // 30 s, read at once
  const outDir = mkdtempSync(path.join(tmpdir(), 'tv-ffargs-'));
  try {
    const args = buildFfmpegArgs({ ...base, url: input, plan: copyTs, live: true, outDir });
    const r = spawnSync(ffmpeg!, args, { encoding: 'utf8', windowsHide: true });
    expect(r.status, r.stderr).toBe(0); // it exited at the end of its input
    const playlist = readFileSync(path.join(outDir, 'index.m3u8'), 'utf8');
    expect(playlist).toMatch(/^seg_\d{5}\.ts$/m);
    expect(playlist).not.toContain('#EXT-X-ENDLIST');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
