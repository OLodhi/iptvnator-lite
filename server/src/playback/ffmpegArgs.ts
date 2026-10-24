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
// 100 segments x 3 s = the 300 s rewind window for live.
const LIVE_LIST_SIZE = 100;

// Forward slashes are deliberate. With backslash paths on Windows, FFmpeg 9 writes the
// bare fMP4 init file into the process cwd (or, given a full path, puts that full path in
// #EXT-X-MAP). With forward-slash output paths its own directory logic puts init.mp4
// beside the playlist and keeps the playlist reference relative. Windows accepts '/'.
function outPath(dir: string, name: string): string {
  return join(dir, name).replaceAll('\\', '/');
}

function isHlsUrl(url: string): boolean {
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

  // Codecs
  if (plan.video === 'copy') {
    args.push('-c:v', 'copy');
    if (plan.tagHvc1) args.push('-tag:v', 'hvc1');
  } else if (plan.video === 'h264') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '48', '-sc_threshold', '0');
    if (plan.deinterlace) args.push('-vf', 'yadif=mode=0');
  }
  if (plan.audio?.action === 'copy') args.push('-c:a', 'copy');
  else if (plan.audio?.action === 'aac') args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');

  // HLS muxer
  args.push('-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_init_time', '1');
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
  if (fmp4) args.push('-hls_fmp4_init_filename', 'init.mp4');
  args.push('-hls_segment_filename', outPath(outDir, fmp4 ? 'seg_%05d.m4s' : 'seg_%05d.ts'));
  args.push(outPath(outDir, 'index.m3u8'));
  return args;
}
