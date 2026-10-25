import { expect, test } from 'vitest';
import type { ProbeAudio, ProbeResult, ProbeSubtitle } from './probe.ts';
import { defaultAudioIndex, describeTracks, subtitleFor, trackLabel } from './tracks.ts';

const audio = (index: number, over: Partial<ProbeAudio> = {}): ProbeAudio => ({
  index,
  codec: 'aac',
  channels: 2,
  language: null,
  title: null,
  isDefault: false,
  ...over,
});
const sub = (index: number, over: Partial<ProbeSubtitle> = {}): ProbeSubtitle => ({
  index,
  codec: 'subrip',
  language: null,
  title: null,
  isDefault: false,
  forced: false,
  text: true,
  ...over,
});

test('labels use language names, titles and Forced', () => {
  expect(trackLabel(audio(1, { language: 'eng' }), 1)).toBe('English');
  expect(trackLabel(sub(3, { language: 'nld', title: 'Dutch SDH' }), 1)).toBe('Dutch (Dutch SDH)');
  expect(trackLabel(sub(4, { language: 'eng', forced: true }), 2)).toBe('English — Forced');
  // A title that only repeats the language adds nothing.
  expect(trackLabel(audio(1, { language: 'eng', title: 'English' }), 1)).toBe('English');
  expect(trackLabel(audio(1, { language: 'fre', title: 'FRE' }), 1)).toBe('French');
  // A title without a language is the label; an unknown code is shown as it is.
  expect(trackLabel(audio(1, { title: 'Director commentary' }), 1)).toBe('Director commentary');
  expect(trackLabel(audio(1, { language: 'qaa' }), 1)).toBe('qaa');
});

test('tracks without tags are numbered', () => {
  const probe: ProbeResult = { formatName: 'matroska,webm', durationSec: 60, video: null, audio: [audio(1), audio(2)], subtitles: [sub(3, { forced: true })] };
  const { audio: tracks, subtitles } = describeTracks(probe);
  expect(tracks.map((t) => t.label)).toEqual(['Track 1', 'Track 2']);
  expect(subtitles.map((t) => t.label)).toEqual(['Track 1 — Forced']);
});

test('English audio is the default, then the default disposition, then the first', () => {
  expect(defaultAudioIndex([audio(1, { language: 'nld', isDefault: true }), audio(2, { language: 'eng' })])).toBe(2);
  expect(defaultAudioIndex([audio(1, { language: 'fra' }), audio(2, { language: 'deu', isDefault: true })])).toBe(2);
  expect(defaultAudioIndex([audio(1, { language: 'fra' }), audio(2, { language: 'spa' })])).toBe(1);
  // P4-R2: English is eng, en or english.
  expect(defaultAudioIndex([audio(1, { isDefault: true }), audio(2, { language: 'en' })])).toBe(2);
  expect(defaultAudioIndex([audio(1, { isDefault: true }), audio(2, { language: 'english' })])).toBe(2);
  // Review Focus 3: untagged tracks fall back to the default disposition, then the first.
  expect(defaultAudioIndex([audio(1), audio(2, { isDefault: true })])).toBe(2);
  expect(defaultAudioIndex([audio(1), audio(2)])).toBe(1);
  expect(defaultAudioIndex([])).toBeNull();
});

test('picture subtitles are listed unavailable', () => {
  const probe: ProbeResult = {
    formatName: 'matroska,webm',
    durationSec: 60,
    video: null,
    audio: [audio(1, { language: 'nld', isDefault: true }), audio(2, { language: 'eng', title: 'Commentary' })],
    subtitles: [sub(3, { language: 'eng' }), sub(4, { codec: 'hdmv_pgs_subtitle', language: 'eng', text: false, forced: true })],
  };
  expect(describeTracks(probe)).toEqual({
    audio: [
      { index: 1, label: 'Dutch', language: 'nl', isDefault: true, forced: false, available: true },
      { index: 2, label: 'English (Commentary)', language: 'en', isDefault: false, forced: false, available: true },
    ],
    subtitles: [
      { index: 3, label: 'English', language: 'en', isDefault: false, forced: false, available: true },
      { index: 4, label: 'English — Forced', language: 'en', isDefault: false, forced: true, available: false },
    ],
  });
});

test('subtitleFor prefers a non-forced text track in the language', () => {
  const subs = [
    sub(3, { codec: 'hdmv_pgs_subtitle', language: 'eng', text: false }),
    sub(4, { language: 'eng', forced: true }),
    sub(5, { language: 'eng' }),
    sub(6, { language: 'dut' }),
  ];
  expect(subtitleFor(subs, 'eng')).toBe(5);
  // P4-R2: a 2- or 3-letter code (either 639-2 form) names the same language.
  expect(subtitleFor(subs, 'en')).toBe(5);
  expect(subtitleFor(subs, 'nl')).toBe(6);
  expect(subtitleFor(subs, 'nld')).toBe(6);
  // Only a forced track in the language: that one. A picture track never.
  expect(subtitleFor([sub(4, { language: 'eng', forced: true })], 'en')).toBe(4);
  expect(subtitleFor([subs[0]!], 'en')).toBeNull();
  expect(subtitleFor(subs, 'fr')).toBeNull();
  expect(subtitleFor(subs, null)).toBeNull();
});
