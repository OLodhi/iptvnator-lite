import type HlsType from 'hls.js';

type HlsCtor = typeof HlsType;

export type StreamHandle = { destroy(): void };

/** Attach a server stream URL to a <video>. Native HLS where available, hls.js otherwise, plain src for direct. */
export function attachStream(video: HTMLVideoElement, url: string, deps: { Hls?: HlsCtor } = {}): StreamHandle {
  const clearSrc = () => {
    video.removeAttribute('src');
    video.load?.();
  };

  const isDirect = new URL(url, 'http://x').pathname.endsWith('/direct');
  if (isDirect || video.canPlayType('application/vnd.apple.mpegurl') !== '') {
    video.src = url;
    return { destroy: clearSrc };
  }

  const Hls = deps.Hls;
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
