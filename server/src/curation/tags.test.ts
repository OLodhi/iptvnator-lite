import { expect, test } from 'vitest';
import { detectTagStyle, friendlyName, stripTag, tagOf } from './tags.ts';

const live = ['UK| GENERAL', 'UK| NEWS', 'AR| MOROCCO', 'LAT| CHILE', 'EXYU| SPORTSKI KANALI', 'BEE| BEIN SPORTS',
  '4K UHD 3840P', '24/7 DISNEY+ ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'UK| MC VIDEO ᴴᴰ', 'UK| PAY PER VIEW PPV'];

test('detects pipe tags on live', () => {
  expect(detectTagStyle(live)).toEqual({ style: 'tagged', pattern: 'pipe' });
  expect(tagOf('UK| GENERAL', 'pipe')).toBe('UK');
  expect(tagOf('4K UHD 3840P', 'pipe')).toBeNull();
  expect(tagOf('EXYU| SPORTSKI KANALI', 'pipe')).toBe('EXYU');
});

test('detects wrapped pipe tags on movies', () => {
  const vod = ['|EN| NETFLIX', '|FR| DOCUMENTAIRE', '|AR| أفلام فرجة', '|PL| BAJKI 4K', 'TOP 250'];
  expect(detectTagStyle(vod)).toEqual({ style: 'tagged', pattern: 'pipe-wrapped' });
  expect(tagOf('|EN| NETFLIX', 'pipe-wrapped')).toBe('EN');
});

test('detects bracket, dash and colon styles', () => {
  expect(detectTagStyle(['[UK] Sports', '[us] News', '[FR] Cinema'])).toEqual({ style: 'tagged', pattern: 'bracket' });
  expect(tagOf('[uk] Sports', 'bracket')).toBe('UK');
  expect(detectTagStyle(['UK - Sports', 'US - News', 'FR - Cinema'])).toEqual({ style: 'tagged', pattern: 'dash' });
  expect(tagOf('UK - Sports', 'dash')).toBe('UK');
  expect(detectTagStyle(['UK: Sports', 'US: News', 'FR: Cinema'])).toEqual({ style: 'tagged', pattern: 'colon' });
  expect(tagOf('UK: Sports', 'colon')).toBe('UK');
});

test('handles non-breaking spaces', () => {
  expect(tagOf('UK | SPORTS', 'pipe')).toBe('UK');
  expect(stripTag('UK | SPORTS', 'UK', 'pipe')).toBe('SPORTS');
});

test('classifies mixed and untagged lists', () => {
  expect(detectTagStyle(['UK| A', 'UK| B', 'SPORTS', 'NEWS', 'MOVIES'])).toEqual({ style: 'mixed', pattern: 'pipe' });
  expect(detectTagStyle(['SPORTS', 'NEWS', 'SKY SPORTS'])).toEqual({ style: 'untagged', pattern: null });
  expect(detectTagStyle([])).toEqual({ style: 'untagged', pattern: null });
});

test('does not mistake words for tags', () => {
  const names = ['NEWS - LIVE', ...Array.from({ length: 19 }, (_, i) => `CHANNEL ${i}`)];
  expect(detectTagStyle(names)).toEqual({ style: 'untagged', pattern: null });
  expect(tagOf('A: B', 'colon')).toBeNull();
  expect(tagOf('A| B', 'pipe')).toBeNull();
});

test('stripTag removes the tag and separator only', () => {
  expect(stripTag('UK| SPORTS HEVC', 'UK', 'pipe')).toBe('SPORTS HEVC');
  expect(stripTag('|EN| NETFLIX', 'EN', 'pipe-wrapped')).toBe('NETFLIX');
  expect(stripTag('US| NEWS', 'UK', 'pipe')).toBe('US| NEWS');
});

test('friendly names only when unambiguous', () => {
  expect(friendlyName('UK')).toBe('United Kingdom');
  expect(friendlyName('EN')).toBe('English');
  for (const t of ['AR', 'IR', 'LAT', 'EXYU', 'BEE', 'IS']) expect(friendlyName(t)).toBeNull();
});
