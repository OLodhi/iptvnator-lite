import { describe, expect, test } from 'vitest';
import { cleanEpisodeTitle, qualityLabel } from './episodeTitle.ts';

describe('cleanEpisodeTitle', () => {
  test.each([
    ['NL - THE BEAR (2022) - S01E01 - System', 1, 'System'],
    ['The Bear S03E02 Next', 2, 'Next'],
    ['Breaking Bad - 1x05 - Gray Matter', 5, 'Gray Matter'],
    ['Show: s2e10: Title', 10, 'Title'],
    ['Show S01E01.Title', 1, 'Title'],
    ['Behind the scenes', 1, 'Behind the scenes'],
    ['  Behind the scenes  ', 1, 'Behind the scenes'],
    ['S01E01', 1, 'Episode 1'],
    ['Show - S01E04 - ', 4, 'Episode 4'],
    ['', 7, 'Episode 7'],
  ])('%j (n=%i) -> %j', (raw, n, want) => {
    expect(cleanEpisodeTitle(raw, n)).toBe(want);
  });
});

describe('qualityLabel', () => {
  test('HD, 4K and neither', () => {
    expect(qualityLabel(1920, 1080)).toBe('HD');
    expect(qualityLabel(3840, 2160)).toBe('4K');
    expect(qualityLabel(720, 576)).toBeNull();
    expect(qualityLabel(1280, null)).toBe('HD');
    expect(qualityLabel(null, 2160)).toBe('4K');
    expect(qualityLabel(null, null)).toBeNull();
  });
});
