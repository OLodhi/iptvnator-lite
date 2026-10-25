import { expect, test } from 'vitest';
import { applyNativeDefaults, nativeTracks } from './nativeTracks.ts';

function videoWith(audio: { label: string; language: string; enabled: boolean }[] | null, text: { kind: string; label: string; language: string; mode: string }[]) {
  const v = document.createElement('video');
  if (audio) Object.defineProperty(v, 'audioTracks', { get: () => audio });
  Object.defineProperty(v, 'textTracks', { get: () => text });
  return v;
}

test('tracks are named by language and title, else Track n; subtitles are the subtitle and caption tracks', () => {
  const v = videoWith(
    [
      { label: '', language: '', enabled: false },
      { label: 'Commentary', language: 'en-GB', enabled: true },
      { label: 'ENG', language: 'eng', enabled: false },
      { label: 'Nederlands', language: 'dut', enabled: false },
    ],
    [
      { kind: 'chapters', label: 'Chapters', language: '', mode: 'hidden' },
      { kind: 'subtitles', label: 'SDH', language: 'en', mode: 'disabled' },
      { kind: 'captions', label: '', language: 'pt-BR', mode: 'showing' },
    ],
  );
  const tracks = nativeTracks(v);
  expect(tracks.audio.map((t) => [t.index, t.label, t.language])).toEqual([
    [0, 'Track 1', null],
    [1, 'English (Commentary)', 'en'],
    [2, 'English', 'en'],
    [3, 'Dutch (Nederlands)', 'nl'],
  ]);
  expect(tracks.audioIndex).toBe(1);
  expect(tracks.subtitles.map((t) => [t.index, t.label, t.language])).toEqual([
    [1, 'English (SDH)', 'en'],
    [2, 'Portuguese', 'pt'],
  ]);
  expect(tracks.subtitleIndex).toBe(2);

  // Without audio track lists (Chrome, Firefox) there is nothing to choose.
  expect(nativeTracks(videoWith(null, [])).audio).toEqual([]);
});

test('defaults: English audio unless it already is, and the remembered language shown when there is one', () => {
  const audio = [
    { label: '', language: 'fre', enabled: true },
    { label: '', language: 'english', enabled: false },
  ];
  const text = [{ kind: 'subtitles', label: '', language: 'nld', mode: 'disabled' }];
  const v = videoWith(audio, text);
  applyNativeDefaults(v, 'fr');
  expect(audio.map((t) => t.enabled)).toEqual([false, true]);
  expect(text[0]!.mode).toBe('disabled'); // no French subtitles
  applyNativeDefaults(v, 'nl');
  expect(text[0]!.mode).toBe('showing');

  // No English audio: the enabled track stays.
  const french = [{ label: '', language: 'fra', enabled: true }, { label: '', language: 'deu', enabled: false }];
  applyNativeDefaults(videoWith(french, []), null);
  expect(french.map((t) => t.enabled)).toEqual([true, false]);
});
