import type HlsType from 'hls.js';
import { seekWhenOpen } from './seekWhenOpen.ts';

type HlsCtor = typeof HlsType;

const HLS_TYPE = 'application/vnd.apple.mpegurl';

export type StreamHandle = {
  destroy(): void;
  /** Shows or hides the stream's subtitles: an HLS session's subtitle rendition, or a direct file's own text tracks. */
  showSubtitles(on: boolean): void;
};

export type AttachOptions = {
  Hls?: HlsCtor;
  /** Direct streams only: where to seek once the file's metadata is known. An HLS session already starts there. */
  startAtSec?: number;
  /** Not live: hls.js starts at the beginning rather than near the end of a playlist that is still growing. */
  vod?: boolean;
  /** The browser's user agent; navigator.userAgent when left out. */
  ua?: string;
};

/**
 * Whether to let the element play HLS itself: only Safari (iOS, iPadOS and the Mac) does it well. Desktop Chrome
 * now claims native HLS and fails on live streams, so everywhere else hls.js is used when it is supported.
 */
export function prefersNativeHls(ua: string, video: HTMLVideoElement): boolean {
  if (video.canPlayType(HLS_TYPE) === '') return false;
  // iPadOS asks for the desktop site by default: it says Macintosh, but has a touch screen.
  const touchMac = /Macintosh/.test(ua) && (video.ownerDocument.defaultView?.navigator.maxTouchPoints ?? 0) > 1;
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) return true;
  return /Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua);
}

/** Seeks to `sec` once the file is open, unless that is the start; returns a canceller. */
const seekOnce = (video: HTMLVideoElement, sec: number | undefined): (() => void) =>
  sec === undefined || sec <= 0 ? () => {} : seekWhenOpen(video, sec);

function showTextTracks(video: HTMLVideoElement, on: boolean) {
  const tracks = video.textTracks;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (track.kind === 'subtitles' || track.kind === 'captions') track.mode = on ? 'showing' : 'disabled';
  }
}

/** The element plays the URL itself, and its subtitles are its own text tracks. */
function elementStream(video: HTMLVideoElement, url: string): StreamHandle {
  video.src = url;
  let shown: boolean | undefined;
  // Safari lists an HLS subtitle rendition only once it has read the playlist: a choice made before then applies to it.
  const applyShown = () => showTextTracks(video, shown === true);
  return {
    destroy: () => {
      if (shown !== undefined) video.textTracks.removeEventListener('addtrack', applyShown);
      video.removeAttribute('src');
      video.load?.();
    },
    showSubtitles: (on) => {
      if (shown === undefined) video.textTracks.addEventListener('addtrack', applyShown);
      shown = on;
      showTextTracks(video, on);
    },
  };
}

function hlsJsStream(Hls: HlsCtor, video: HTMLVideoElement, url: string, vod: boolean): StreamHandle {
  // Live gets duration Infinity and a seekable window over the segments still listed, as Safari reports it: that is
  // how the player tells live from a remux in progress, and how far behind live it is.
  const hls = new Hls(vod ? { startPosition: 0 } : { liveDurationInfinity: true });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  return {
    destroy: () => hls.destroy(),
    showSubtitles: (on) => {
      hls.subtitleDisplay = on;
      // Until the playlist is read there is no rendition to pick, and asking for one would stop hls.js picking
      // the session's default rendition; subtitleDisplay alone decides whether that one shows.
      if (hls.subtitleTracks.length > 0) hls.subtitleTrack = on ? 0 : -1;
    },
  };
}

/** Attach a server stream URL to a <video>: plain src for direct, native HLS on Safari, hls.js elsewhere. */
export function attachStream(video: HTMLVideoElement, url: string, opts: AttachOptions = {}): StreamHandle {
  if (new URL(url, 'http://x').pathname.endsWith('/direct')) {
    const stream = elementStream(video, url);
    const cancelSeek = seekOnce(video, opts.startAtSec);
    return {
      ...stream,
      destroy: () => {
        cancelSeek();
        stream.destroy();
      },
    };
  }

  const Hls = opts.Hls;
  if (!prefersNativeHls(opts.ua ?? navigator.userAgent, video) && Hls?.isSupported()) {
    return hlsJsStream(Hls, video, url, opts.vod ?? false);
  }

  // Safari, or nothing better available: let the element try.
  return elementStream(video, url);
}
