import type { MediaTrack } from '@tv/shared';
import type { ProbeAudio, ProbeResult, ProbeSubtitle } from './probe.ts';

// P4-R2: language tags are compared as codes, with the 3-letter forms (both ISO 639-2 variants) and the odd
// spelled-out tag mapped to their 2-letter code. A Map, so a tag such as 'constructor' finds nothing.
const TWO_LETTER = new Map([
  ['eng', 'en'],
  ['english', 'en'],
  ['nld', 'nl'],
  ['dut', 'nl'],
  ['fra', 'fr'],
  ['fre', 'fr'],
  ['deu', 'de'],
  ['ger', 'de'],
  ['spa', 'es'],
  ['ita', 'it'],
  ['por', 'pt'],
  ['ara', 'ar'],
  ['tur', 'tr'],
  ['pol', 'pl'],
]);

const LANGUAGE_NAMES = new Intl.DisplayNames('en', { type: 'language' });

/** A language tag as a comparable code: 2 letters where the table knows it, otherwise the tag lowercased. */
function languageCode(tag: string): string {
  const t = tag.trim().toLowerCase();
  return TWO_LETTER.get(t) ?? t;
}

/** "English" for 'en'; a code Intl doesn't know (or can't parse) is shown as it is. */
function languageName(code: string): string {
  try {
    return LANGUAGE_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "English", "Dutch (Dutch SDH)", "English — Forced"; `Track {n}` for a track with neither a language nor a title. */
export function trackLabel(t: ProbeAudio | ProbeSubtitle, n: number): string {
  const code = t.language === null ? null : languageCode(t.language);
  const name = code === null ? null : languageName(code);
  let label = name ?? t.title ?? `Track ${n}`;
  // A title that only repeats the language ("English", "ENG") adds nothing.
  if (name !== null && t.title !== null && t.title.toLowerCase() !== name.toLowerCase() && languageCode(t.title) !== code) {
    label += ` (${t.title})`;
  }
  if ('forced' in t && t.forced) label += ' — Forced';
  return label;
}

/** The probe's audio and subtitle streams as the player lists them; a picture subtitle is listed but unavailable. */
export function describeTracks(probe: ProbeResult): { audio: MediaTrack[]; subtitles: MediaTrack[] } {
  const language = (t: ProbeAudio | ProbeSubtitle) => (t.language === null ? null : languageCode(t.language));
  return {
    audio: probe.audio.map((a, i) => ({
      index: a.index,
      label: trackLabel(a, i + 1),
      language: language(a),
      isDefault: a.isDefault,
      forced: false,
      available: true,
    })),
    subtitles: probe.subtitles.map((s, i) => ({
      index: s.index,
      label: trackLabel(s, i + 1),
      language: language(s),
      isDefault: s.isDefault,
      forced: s.forced,
      available: s.text,
    })),
  };
}

/** English audio when there is some, else the stream's default track, else the first; null with no audio. */
export function defaultAudioIndex(audio: ProbeAudio[]): number | null {
  const english = audio.find((a) => a.language !== null && languageCode(a.language) === 'en');
  return (english ?? audio.find((a) => a.isDefault) ?? audio[0])?.index ?? null;
}

/** The first text subtitle track in `language` (any form of its code), preferring one that isn't forced. */
export function subtitleFor(subs: ProbeSubtitle[], language: string | null): number | null {
  if (language === null) return null;
  const code = languageCode(language);
  const matching = subs.filter((s) => s.text && s.language !== null && languageCode(s.language) === code);
  return (matching.find((s) => !s.forced) ?? matching[0])?.index ?? null;
}
