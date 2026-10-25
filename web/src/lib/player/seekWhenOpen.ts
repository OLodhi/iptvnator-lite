/** Seeks to `sec` on the first `loadedmetadata`, or at once if the metadata is already there; returns a canceller. */
export function seekWhenOpen(video: HTMLVideoElement, sec: number): () => void {
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
