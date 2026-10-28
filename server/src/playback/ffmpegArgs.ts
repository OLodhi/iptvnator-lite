import { join } from 'node:path';
import type { HlsPlan } from './policy.ts';

export type FfmpegInput = {
  url: string;
  userAgent: string;
  plan: HlsPlan;
  live: boolean;
  startAtSec: number;
  outDir: string;
  startNumber: number;
  /** ffprobe's format_name for the input, when known. A `.m3u8` URL can serve plain TS (providers do). */
  inputFormat?: string;
};

const SEGMENT_SECONDS = 3;
// 200 segments x 3 s = the 600 s rewind window for live.
const LIVE_LIST_SIZE = 200;

/**
 * With a subtitle rendition FFmpeg writes a master playlist naming one variant (stream_%v.m3u8, %v = 0) and its
 * WebVTT playlist (stream_0_vtt.m3u8, with segments stream_0<n>.vtt), all beside it.
 */
export const MASTER_PLAYLIST = 'master.m3u8';
export const VARIANT_PLAYLIST = 'stream_0.m3u8';
// FFmpeg names a variant in the master only once it knows a bit rate for it, and it takes that from the streams
// alone; a stream copied from an MKV has none, so the master would name no variant until the whole title was
// written. These label copied streams (they don't change them): BANDWIDTH is a hint, and there is only one variant.
const NOMINAL_VIDEO_BITRATE = '8M';
const NOMINAL_AUDIO_BITRATE = '192k';

// Forward slashes are deliberate. With backslash paths on Windows, FFmpeg 9 writes the
// bare fMP4 init file into the process cwd (or, given a full path, puts that full path in
// #EXT-X-MAP). With forward-slash output paths its own directory logic puts init.mp4
// beside the playlist and keeps the playlist reference relative. Windows accepts '/'.
function outPath(dir: string, name: string): string {
  return join(dir, name).replaceAll('\\', '/');
}

export function isHlsUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

export function buildFfmpegArgs(input: FfmpegInput): string[] {
  const { url, userAgent, plan, live, startAtSec, outDir, startNumber } = input;
  const remote = url.startsWith('http://') || url.startsWith('https://');
  const fmp4 = plan.segment === 'fmp4';
  const subtitle = plan.subtitle;

  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];

  // Input flags
  args.push('-fflags', '+genpts+discardcorrupt');
  if (remote) {
    args.push('-user_agent', userAgent);
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10');
  }
  // The HLS demuxer fetches segments over several HTTP connections by default; a one-connection
  // provider refuses the extra one. hls-demuxer option, so only for HLS inputs.
  // Unknown or non-HLS content behind a .m3u8 URL must not get it: FFmpeg rejects the option.
  const hlsContent = input.inputFormat === undefined || input.inputFormat.includes('hls');
  if (remote && isHlsUrl(url) && hlsContent) args.push('-http_multiple', '0');
  if (startAtSec > 0) args.push('-ss', String(startAtSec));
  args.push('-i', url);

  // Maps
  if (plan.video === 'none') args.push('-vn');
  else args.push('-map', '0:v:0');
  if (plan.audio === null) args.push('-an');
  else args.push('-map', `0:${plan.audio.index}`);
  if (subtitle) args.push('-map', `0:${subtitle.index}`);

  // Codecs
  if (plan.video === 'copy') {
    args.push('-c:v', 'copy');
    if (plan.tagHvc1) args.push('-tag:v', 'hvc1');
  } else if (plan.video === 'h264') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '48', '-sc_threshold', '0');
    if (plan.deinterlace) args.push('-vf', 'yadif=mode=0');
  }
  if (plan.audio?.action === 'copy') {
    args.push('-c:a', 'copy');
    if (plan.adtsToAsc) args.push('-bsf:a', 'aac_adtstoasc');
  } else if (plan.audio?.action === 'aac') args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  if (subtitle) {
    args.push('-c:s', 'webvtt');
    if (plan.video === 'copy') args.push('-b:v', NOMINAL_VIDEO_BITRATE);
    if (plan.audio?.action === 'copy') args.push('-b:a', NOMINAL_AUDIO_BITRATE);
    // FFmpeg's WebVTT segments carry no X-TIMESTAMP-MAP, so players read their cue times against MPEG-TS time 0.
    // Without the muxer's default 1.4 s start offset the video starts there too, and the cues line up.
    args.push('-muxdelay', '0');
  }

  // HLS muxer
  args.push('-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_init_time', '1');
  if (subtitle) {
    const streams = [plan.video === 'none' ? null : 'v:0', plan.audio === null ? null : 'a:0', 's:0', 'sgroup:subs'];
    args.push('-master_pl_name', MASTER_PLAYLIST, '-var_stream_map', streams.filter((x) => x !== null).join(','));
  }
  if (live) {
    args.push('-hls_list_size', String(LIVE_LIST_SIZE));
    // omit_endlist: an FFmpeg that exits (and is relaunched) must not mark the live playlist finished,
    // or the player stops (R31).
    let flags = 'delete_segments+independent_segments+omit_endlist';
    if (startNumber > 0) flags += '+discont_start';
    args.push('-hls_flags', flags);
  } else {
    args.push('-hls_playlist_type', 'event', '-hls_list_size', '0', '-hls_flags', 'independent_segments');
  }
  if (startNumber > 0) args.push('-start_number', String(startNumber));
  args.push('-hls_segment_type', fmp4 ? 'fmp4' : 'mpegts');
  // A single variant's init file keeps this name.
  if (fmp4) args.push('-hls_fmp4_init_filename', 'init.mp4');
  // Variant streams need FFmpeg's %v in their file names.
  const segment = subtitle ? 'seg_%v_%05d' : 'seg_%05d';
  args.push('-hls_segment_filename', outPath(outDir, `${segment}.${fmp4 ? 'm4s' : 'ts'}`));
  args.push(outPath(outDir, subtitle ? 'stream_%v.m3u8' : 'index.m3u8'));
  return args;
}
