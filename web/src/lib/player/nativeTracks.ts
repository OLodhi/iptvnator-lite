import type { MediaTrack, SessionTracks } from '@tv/shared';

/**
 * A direct file's audio and subtitle tracks are the element's own (Safari lists them; most browsers list no audio).
 * A direct session plays the whole file, so switching them needs no new session. Each track's `index` is its place in
 * the element's list.
 */

/** Not in TypeScript's DOM types: only Safari has audio track lists without a flag. */
type AudioTrackLike = { enabled: boolean; label: string; language: string };
type TrackList<T> = { readonly length: number; readonly [index: number]: T };

// P4-R2, as the server compares languages: 3-letter codes (both ISO 639-2 forms) and the odd spelled-out tag as 2.
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

/** A track's language as a comparable code: `en-GB` and `eng` are `en`. Null when it has none. */
function languageCode(tag: string): string | null {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return primary ? (TWO_LETTER.get(primary) ?? primary) : null;
}

/** "English" for 'en'; a code Intl doesn't know is shown as it is. */
function languageName(code: string): string {
  try {
    return LANGUAGE_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

/** As the server labels a probed track: "English", "English (Commentary)", or `Track {n}` with neither language nor title. */
function describe(track: { label: string; language: string }, index: number): MediaTrack {
  const code = languageCode(track.language);
  const name = code === null ? null : languageName(code);
  const title = track.label.trim() || null;
  let label = name ?? title ?? `Track ${index + 1}`;
  // A title that only repeats the language ("English", "ENG") adds nothing.
  if (name !== null && title !== null && title.toLowerCase() !== name.toLowerCase() && languageCode(title) !== code) {
    label += ` (${title})`;
  }
  return { index, label, language: code, isDefault: false, forced: false, available: true };
}

function audioTracks(video: HTMLVideoElement): AudioTrackLike[] {
  const list = (video as HTMLVideoElement & { audioTracks?: TrackList<AudioTrackLike> }).audioTracks;
  return list ? Array.from({ length: list.length }, (_, i) => list[i]!) : [];
}

/** The subtitle and caption tracks, with their place in the element's list (which also holds chapters and metadata). */
function textTracks(video: HTMLVideoElement): { track: TextTrack; index: number }[] {
  const list = video.textTracks as TrackList<TextTrack> | undefined;
  if (!list) return [];
  return Array.from({ length: list.length }, (_, index) => ({ track: list[index]!, index })).filter(
    ({ track }) => track.kind === 'subtitles' || track.kind === 'captions',
  );
}

/** The element's tracks in the sheets' shape, with the ones playing and showing. */
export function nativeTracks(video: HTMLVideoElement): SessionTracks {
  const audio = audioTracks(video);
  const text = textTracks(video);
  const playing = audio.findIndex((t) => t.enabled);
  const showing = text.find(({ track }) => track.mode === 'showing');
  return {
    audio: audio.map(describe),
    subtitles: text.map(({ track, index }) => describe(track, index)),
    audioIndex: playing < 0 ? null : playing,
    subtitleIndex: showing?.index ?? null,
  };
}

/** Plays the audio track at `index`, and only that one. */
export function enableAudio(video: HTMLVideoElement, index: number): void {
  audioTracks(video).forEach((t, i) => (t.enabled = i === index));
}

/** Shows the text track at `index` and hides the other subtitles; null hides them all. */
export function showSubtitle(video: HTMLVideoElement, index: number | null): void {
  for (const { track, index: i } of textTracks(video)) track.mode = i === index ? 'showing' : 'disabled';
}

/** Once the file is open: English audio when the enabled track isn't English, and subtitles in the remembered language. */
export function applyNativeDefaults(video: HTMLVideoElement, subtitleLanguage: string | null): void {
  const audio = audioTracks(video);
  const english = (t: AudioTrackLike) => languageCode(t.language) === 'en';
  if (!audio.some((t) => t.enabled && english(t))) {
    const at = audio.findIndex(english);
    if (at >= 0) enableAudio(video, at);
  }
  const wanted = subtitleLanguage === null ? null : languageCode(subtitleLanguage);
  const match = wanted === null ? undefined : textTracks(video).find(({ track }) => languageCode(track.language) === wanted);
  if (match) showSubtitle(video, match.index);
}
