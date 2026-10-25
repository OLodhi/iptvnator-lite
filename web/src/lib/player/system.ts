/** Picture-in-picture, AirPlay and the lock screen. Every missing API is a no-op or false, never a throw. */

type PresentationVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
  webkitShowPlaybackTargetPicker?: () => void;
};

export function canPip(video: HTMLVideoElement): boolean {
  const v = video as PresentationVideo;
  if (typeof v.webkitSetPresentationMode === 'function') return v.webkitSupportsPresentationMode?.('picture-in-picture') ?? true;
  return typeof v.requestPictureInPicture === 'function' && document.pictureInPictureEnabled !== false;
}

export async function togglePip(video: HTMLVideoElement): Promise<void> {
  const v = video as PresentationVideo;
  if (typeof v.webkitSetPresentationMode === 'function') {
    v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    return;
  }
  if (typeof v.requestPictureInPicture !== 'function') return;
  if (document.pictureInPictureElement) await document.exitPictureInPicture();
  else await v.requestPictureInPicture();
}

export function canAirPlay(): boolean {
  return typeof window !== 'undefined' && 'WebKitPlaybackTargetAvailabilityEvent' in window;
}

export function showAirPlay(video: HTMLVideoElement): void {
  (video as PresentationVideo).webkitShowPlaybackTargetPicker?.();
}

type Action = 'play' | 'pause' | 'seekbackward' | 'seekforward' | 'previoustrack' | 'nexttrack';
const ACTIONS: Action[] = ['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack'];

/** Sets (or, with null, clears) the lock screen / Control Centre info and buttons. */
export function setNowPlaying(
  meta: { title: string; artist?: string; artworkUrl?: string } | null,
  actions: Partial<Record<Action, () => void>>,
): void {
  const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!session) return;
  if (meta && typeof MediaMetadata !== 'undefined') {
    session.metadata = new MediaMetadata({
      title: meta.title,
      artist: meta.artist ?? '',
      artwork: meta.artworkUrl ? [{ src: meta.artworkUrl }] : [],
    });
  } else {
    session.metadata = null;
  }
  for (const name of ACTIONS) {
    const handler = meta ? actions[name] : undefined;
    try {
      session.setActionHandler(name, handler ?? null);
    } catch {
      // An action this browser does not support.
    }
  }
}
