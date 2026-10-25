// The last subtitle language chosen, per device, until accounts arrive (Plan 5).
const KEY = 'tv.subtitleLang';

export function subtitleLanguage(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberSubtitleLanguage(lang: string | null): void {
  try {
    if (lang) localStorage.setItem(KEY, lang);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked or full: the preference simply isn't kept.
  }
}
