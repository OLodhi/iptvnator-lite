import type HlsType from 'hls.js';

type HlsCtor = typeof HlsType;

export type StreamHandle = { destroy(): void };

export type AttachOptions = {
  Hls?: HlsCtor;
  /** Direct streams only: where to seek once the file's metadata is known. An HLS session already starts there. */
  startAtSec?: number;
};

/** Seeks to `sec` on the first `loadedmetadata`, or at once if metadata is already there; returns a canceller. */
function seekOnce(video: HTMLVideoElement, sec: number | undefined): () => void {
  if (sec === undefined || sec <= 0) return () => {};
  const seek = () => {
    video.currentTime = sec;
  };
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    seek();
    return () => {};
  }
  video.addEventListener('loadedmetadata', seek, { once: true });
  return () => video.removeEventListener('loadedmetadata', seek);
}

/** Attach a server stream URL to a <video>. Native HLS where available, hls.js otherwise, plain src for direct. */
export function attachStream(video: HTMLVideoElement, url: string, opts: AttachOptions = {}): StreamHandle {
  const clearSrc = () => {
    video.removeAttribute('src');
    video.load?.();
  };

  if (new URL(url, 'http://x').pathname.endsWith('/direct')) {
    video.src = url;
    const cancelSeek = seekOnce(video, opts.startAtSec);
    return {
      destroy: () => {
        cancelSeek();
        clearSrc();
      },
    };
  }

  if (video.canPlayType('application/vnd.apple.mpegurl') !== '') {
    video.src = url;
    return { destroy: clearSrc };
  }

  const Hls = opts.Hls;
  if (Hls && Hls.isSupported()) {
    const hls = new Hls();
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    return { destroy: () => hls.destroy() };
  }

  // Nothing better available: let the element try.
  video.src = url;
  return { destroy: clearSrc };
}
