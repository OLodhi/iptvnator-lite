// Whether the series page hides watched episodes, per device.
const KEY = 'tv.hideWatched';

export function hideWatched(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setHideWatched(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked or full: the choice simply isn't kept.
  }
}
