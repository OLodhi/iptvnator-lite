/**
 * Safari keeps the screen on only for a playing video that can make a sound, so under a muted one the phone dims and
 * locks. While a muted video plays on screen, a screen wake lock stands in. AirPlay is left alone: Safari lets the
 * phone's own screen sleep then, sound or not.
 */

type WirelessVideo = HTMLVideoElement & { webkitCurrentPlaybackTargetIsWireless?: boolean };

const EVENTS = ['play', 'pause', 'ended', 'emptied', 'volumechange', 'webkitcurrentplaybacktargetiswirelesschanged'];

/** Returns the function that lets go and stops listening. Without the API, or when it is refused, nothing happens. */
export function keepAwakeWhileMuted(video: HTMLVideoElement): () => void {
  const wakeLock = typeof navigator !== 'undefined' ? (navigator.wakeLock as WakeLock | undefined) : undefined;
  if (!wakeLock) return () => {};
  let lock: WakeLockSentinel | null = null;
  let requesting = false;
  let stopped = false;

  const wanted = () =>
    !stopped &&
    !video.paused &&
    !video.ended &&
    video.muted &&
    document.visibilityState === 'visible' &&
    !(video as WirelessVideo).webkitCurrentPlaybackTargetIsWireless;

  const update = async () => {
    if (!wanted()) {
      const held = lock;
      lock = null;
      held?.release().catch(() => {});
      return;
    }
    // Safari drops the lock itself while the page is hidden, so one it released is asked for again.
    if (requesting || (lock && !lock.released)) return;
    requesting = true;
    try {
      const got = await wakeLock.request('screen');
      if (wanted()) lock = got;
      else got.release().catch(() => {});
    } catch {
      // Refused: the screen sleeps as it did. Asked again only on the next change.
    } finally {
      requesting = false;
    }
  };

  const onChange = () => void update();
  for (const name of EVENTS) video.addEventListener(name, onChange);
  document.addEventListener('visibilitychange', onChange);
  void update();

  return () => {
    stopped = true;
    for (const name of EVENTS) video.removeEventListener(name, onChange);
    document.removeEventListener('visibilitychange', onChange);
    void update();
  };
}
