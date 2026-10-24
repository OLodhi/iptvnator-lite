import type { CurationCategory, CurationUpdate, CurationView } from '@tv/shared';

export type GroupState = 'on' | 'off' | 'some';

/** The A-Z strip letter for a name; anything that doesn't start with a letter files under '#'. */
export function letterFor(name: string): string {
  const first = name.trim().normalize('NFD').charAt(0).toUpperCase();
  return first >= 'A' && first <= 'Z' ? first : '#';
}

/** '#' (digits, symbols, other scripts) first, then A-Z; within a letter, natural name order. */
const byLetterThenName = (a: CurationCategory, b: CurationCategory) => {
  const la = letterFor(a.displayName);
  const lb = letterFor(b.displayName);
  if (la !== lb) return la === '#' ? -1 : lb === '#' ? 1 : la < lb ? -1 : 1;
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base', numeric: true });
};

const stable = (u: CurationUpdate): string =>
  JSON.stringify([Object.entries(u.tags).sort(), Object.entries(u.categories).sort()]);

/**
 * The working copy of one kind's curation. A tag group has a standing rule (its switch); single
 * categories inside it are exceptions. "No tag" categories have no group: each choice is its own rule.
 */
export function createPickerState(view: CurationView) {
  const untagged = [...view.untagged].sort(byLetterThenName);
  const rules = new Map<string, boolean>();
  const choices = new Map<string, boolean>(); // remoteId -> visible, only where it differs from the group rule
  const home = new Map<string, string>(); // remoteId -> tag, for grouped categories
  const untaggedChoice = new Map<string, boolean>();

  for (const g of view.groups) {
    // The stored switch; a group nobody has curated yet starts on only if everything in it is showing.
    const rule = g.rule ?? g.categories.every((c) => c.visible);
    rules.set(g.tag, rule);
    for (const c of g.categories) {
      home.set(c.remoteId, g.tag);
      if (c.visible !== rule) choices.set(c.remoteId, c.visible);
    }
  }
  for (const c of untagged) untaggedChoice.set(c.remoteId, c.visible);

  const isVisible = (remoteId: string): boolean => {
    const tag = home.get(remoteId);
    if (tag === undefined) return untaggedChoice.get(remoteId) ?? false;
    return choices.get(remoteId) ?? rules.get(tag) ?? false;
  };

  const groupState = (tag: string): GroupState => {
    const cats = view.groups.find((g) => g.tag === tag)?.categories ?? [];
    const on = cats.filter((c) => isVisible(c.remoteId)).length;
    return on === 0 ? 'off' : on === cats.length ? 'on' : 'some';
  };

  function toggleGroup(tag: string) {
    const cats = view.groups.find((g) => g.tag === tag)?.categories ?? [];
    rules.set(tag, groupState(tag) !== 'on'); // on -> off; off or partly on -> keep everything
    for (const c of cats) choices.delete(c.remoteId);
  }

  function setVisible(remoteId: string, visible: boolean) {
    const tag = home.get(remoteId);
    if (tag === undefined) {
      untaggedChoice.set(remoteId, visible);
    } else if (visible === rules.get(tag)) {
      choices.delete(remoteId);
    } else {
      choices.set(remoteId, visible);
    }
  }

  const toggleCategory = (remoteId: string) => setVisible(remoteId, !isVisible(remoteId));

  const filter = (query: string): CurationCategory[] => {
    const q = query.trim().toLowerCase();
    return q === '' ? untagged : untagged.filter((c) => c.displayName.toLowerCase().includes(q));
  };

  const keepMatches = (query: string) => filter(query).forEach((c) => setVisible(c.remoteId, true));
  const hideMatches = (query: string) => filter(query).forEach((c) => setVisible(c.remoteId, false));

  const total = () => view.groups.reduce((n, g) => n + g.categories.length, untagged.length);
  const keptCount = () =>
    view.groups.reduce((n, g) => n + g.categories.filter((c) => isVisible(c.remoteId)).length, 0) +
    untagged.filter((c) => isVisible(c.remoteId)).length;

  function azIndex(): { letter: string; index: number }[] {
    const out: { letter: string; index: number }[] = [];
    untagged.forEach((c, index) => {
      const letter = letterFor(c.displayName);
      if (out[out.length - 1]?.letter !== letter) out.push({ letter, index });
    });
    return out;
  }

  function toUpdate(): CurationUpdate {
    const tags: Record<string, boolean> = {};
    const categories: Record<string, boolean> = {};
    for (const [tag, rule] of rules) tags[tag] = rule;
    for (const [remoteId, visible] of choices) categories[remoteId] = visible;
    for (const [remoteId, visible] of untaggedChoice) categories[remoteId] = visible;
    return { tags, categories };
  }

  let baseline = stable(toUpdate());
  /** True only when the current choices differ from what was loaded. */
  const isDirty = () => stable(toUpdate()) !== baseline;
  /** Call after a successful save: the current choices become the new baseline. */
  const markSaved = () => {
    baseline = stable(toUpdate());
  };

  return {
    untagged,
    isDirty,
    markSaved,
    isVisible,
    groupState,
    toggleGroup,
    toggleCategory,
    filter,
    keepMatches,
    hideMatches,
    keptCount,
    total,
    azIndex,
    toUpdate,
  };
}

export type PickerState = ReturnType<typeof createPickerState>;
