import type { TagStyle } from '@tv/shared';

export type TagPattern = 'pipe' | 'pipe-wrapped' | 'bracket' | 'dash' | 'colon';

/** Share of names matching the best pattern at or above which a list counts as tagged. */
export const TAGGED_THRESHOLD = 0.6;
/** Share at or above which a list counts as mixed (when below the tagged threshold). */
export const MIXED_THRESHOLD = 0.2;

const PATTERNS: Record<TagPattern, RegExp> = {
  pipe: /^([A-Z0-9]{2,6})\s*\|\s*/i,
  'pipe-wrapped': /^\|\s*([A-Z0-9]{2,6})\s*\|\s*/i,
  bracket: /^\[\s*([A-Z0-9]{2,6})\s*\]\s*/i,
  dash: /^([A-Z]{2,4})\s+-\s+/i,
  colon: /^([A-Z]{2,4}):\s+/i,
};

const FRIENDLY: Record<string, string> = {
  UK: 'United Kingdom', US: 'United States', CA: 'Canada', FR: 'France', DE: 'Germany', ES: 'Spain',
  IT: 'Italy', NL: 'Netherlands', BE: 'Belgium', PT: 'Portugal', PL: 'Poland', TR: 'Turkey',
  GR: 'Greece', AU: 'Australia', NZ: 'New Zealand', EN: 'English',
};

export function tagOf(name: string, pattern: TagPattern | null): string | null {
  if (!pattern) return null;
  const m = PATTERNS[pattern].exec(name);
  return m ? m[1]!.toUpperCase() : null;
}

export function detectTagStyle(names: string[]): { style: TagStyle; pattern: TagPattern | null } {
  let best: TagPattern | null = null;
  let bestCount = 0;
  for (const pattern of Object.keys(PATTERNS) as TagPattern[]) {
    const count = names.filter((n) => tagOf(n, pattern) !== null).length;
    if (count > bestCount) {
      best = pattern;
      bestCount = count;
    }
  }
  const share = names.length === 0 ? 0 : bestCount / names.length;
  if (best && share >= TAGGED_THRESHOLD) return { style: 'tagged', pattern: best };
  if (best && share >= MIXED_THRESHOLD) return { style: 'mixed', pattern: best };
  return { style: 'untagged', pattern: null };
}

/** Removes the leading tag and its separator; names not carrying that tag come back unchanged. */
export function stripTag(name: string, tag: string, pattern: TagPattern): string {
  if (tagOf(name, pattern) !== tag.toUpperCase()) return name;
  return name.replace(PATTERNS[pattern], '').trim();
}

export function friendlyName(tag: string): string | null {
  return FRIENDLY[tag.toUpperCase()] ?? null;
}
