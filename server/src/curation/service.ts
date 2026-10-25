import type { CurationCategory, CurationGroup, CurationUpdate, CurationView, Kind, TagStyle } from '@tv/shared';
import type { Db } from '../db/db.ts';
import { friendlyName, stripTag, TAG_PATTERNS, tagOf } from './tags.ts';
import type { TagPattern } from './tags.ts';

/** Sync's catch-all for items whose category the provider does not list; recreated as orphans come and go. */
const NONE_ID = '__none__';
const HINT_SIZE = 3;

/** What a browse request needs about a kind, worked out in one pass. */
export type Resolution = {
  visibleIds: Set<number>;
  /** The kind has categories and every one of them is visible. */
  allVisible: boolean;
  displayName: (name: string) => string;
  /** For item names: as `displayName`, but also strips the visible tag when the item spells it in another pattern. */
  itemName: (name: string) => string;
  newCount: number;
};

export interface CurationService {
  view(providerId: number, kind: Kind, userId: number): CurationView;
  /** Replaces the scope's rules for the provider and kind; `userId` null writes the default (admin) rules. */
  save(providerId: number, kind: Kind, update: CurationUpdate, userId: number | null): void;
  /** Hides one category in that scope. Returns false when there is no such category. */
  hideCategory(categoryId: number, userId: number | null): boolean;
  resolution(providerId: number, kind: Kind, userId: number): Resolution;
  visibleCategoryIds(providerId: number, kind: Kind, userId: number): Set<number>;
  /** Strips the tag from names when exactly one tag group is visible; otherwise names come back unchanged. */
  displayNameFn(providerId: number, kind: Kind, userId: number): (name: string) => string;
  newCount(providerId: number, kind: Kind, userId: number): number;
}

/** A category with its kind's detected style (null until a sync has stored one). */
type CategoryRow = {
  id: number;
  remoteId: string;
  name: string;
  tag: string | null;
  firstSeenAt: number;
  tagChangedAt: number;
  style: TagStyle | null;
  pattern: TagPattern | null;
};
type Resolved<T extends CategoryRow> = T & { visible: boolean; isNew: boolean };
type RuleRow = { isDefault: number; targetType: 'tag' | 'category'; target: string; visible: number };
type Rules = { tags: Map<string, boolean>; categories: Map<string, boolean> };

/** Names are trimmed first because the tag patterns are anchored; a name that is nothing but its tag stays as it is. */
function strip(name: string, tag: string, pattern: TagPattern): string {
  const trimmed = name.trim();
  const stripped = stripTag(trimmed, tag, pattern);
  return stripped === trimmed || stripped === '' ? name : stripped;
}

const tagRule = (rules: Rules, tag: string | null): boolean | undefined =>
  tag === null ? undefined : rules.tags.get(tag);

/**
 * Category names lose the single visible tag under the kind's pattern. Item names may spell it differently
 * (`|EN| Action` holds `EN - Title`), so they also try the other patterns; still only that one tag is stripped.
 */
function nameFns(
  pattern: TagPattern | null,
  resolved: Resolved<CategoryRow>[],
): { displayName: (name: string) => string; itemName: (name: string) => string } {
  const tags = [...new Set(resolved.filter((c) => c.visible && c.tag !== null).map((c) => c.tag!))];
  if (tags.length !== 1 || pattern === null) return { displayName: (name) => name, itemName: (name) => name };
  const tag = tags[0]!;
  const displayName = (name: string) => strip(name, tag, pattern);
  const itemName = (name: string) => {
    const stripped = displayName(name);
    if (stripped !== name) return stripped;
    for (const other of TAG_PATTERNS) {
      if (other !== pattern && tagOf(name.trim(), other) === tag.toUpperCase()) return strip(name, tag, other);
    }
    return name;
  };
  return { displayName, itemName };
}

const COLUMNS = `c.id AS id, c.remote_id AS remoteId, c.name AS name, c.tag AS tag, c.first_seen_at AS firstSeenAt,
  c.tag_changed_at AS tagChangedAt, s.style AS style, s.pattern AS pattern`;
const FROM = `FROM categories c LEFT JOIN catalogue_styles s ON s.provider_id = c.provider_id AND s.kind = c.kind
  WHERE c.provider_id = ? AND c.kind = ? ORDER BY c.position, c.id`;

export function createCurationService(deps: { db: Db; now: () => number }): CurationService {
  const { db } = deps;
  const categories = db.prepare(`SELECT ${COLUMNS} ${FROM}`);
  const categoriesWithCounts = db.prepare(
    `SELECT ${COLUMNS}, (SELECT COUNT(*) FROM item_categories ic WHERE ic.category_id = c.id) AS itemCount ${FROM}`,
  );
  const category = db.prepare(
    'SELECT provider_id AS providerId, kind, remote_id AS remoteId FROM categories WHERE id = ?',
  );
  // A null user matches no user rows, leaving only the defaults.
  const rules = db.prepare(
    `SELECT user_id IS NULL AS isDefault, target_type AS targetType, target, visible FROM category_rules
      WHERE provider_id = ? AND kind = ? AND (user_id IS NULL OR user_id = ?)`,
  );
  const anyRule = db.prepare(
    'SELECT 1 FROM category_rules WHERE provider_id = ? AND kind = ? AND (user_id IS NULL OR user_id = ?) LIMIT 1',
  );
  // The user's own review time if there is one, else the default's.
  const savedAt = db
    .prepare(
      `SELECT saved_at FROM curation_state WHERE provider_id = ? AND kind = ? AND (user_id = ? OR user_id IS NULL)
        ORDER BY user_id IS NULL LIMIT 1`,
    )
    .pluck();
  const deleteRules = db.prepare('DELETE FROM category_rules WHERE provider_id = ? AND kind = ? AND user_id IS ?');
  const upsertRule = db.prepare(
    `INSERT INTO category_rules (provider_id, user_id, kind, target_type, target, visible) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider_id, kind, target_type, target, COALESCE(user_id, 0)) DO UPDATE SET visible = excluded.visible`,
  );
  const upsertState = db.prepare(
    `INSERT INTO curation_state (provider_id, user_id, kind, saved_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (provider_id, kind, COALESCE(user_id, 0)) DO UPDATE SET saved_at = excluded.saved_at`,
  );

  /**
   * Resolution order: the user's category rule, the user's tag rule, the default category rule, the default tag rule;
   * then visible if the kind has no rules at all, otherwise hidden. A category hidden only by that last step is new
   * when it arrived, or changed tag, after the last review: nothing that loses its rule on a refresh goes dark silently.
   */
  function resolve<T extends CategoryRow>(providerId: number, kind: Kind, userId: number, rows: T[]): Resolved<T>[] {
    const user: Rules = { tags: new Map(), categories: new Map() };
    const def: Rules = { tags: new Map(), categories: new Map() };
    const found = rules.all(providerId, kind, userId) as RuleRow[];
    for (const r of found) {
      const scope = r.isDefault ? def : user;
      (r.targetType === 'tag' ? scope.tags : scope.categories).set(r.target, r.visible === 1);
    }
    const curated = found.length > 0;
    const reviewedAt = (savedAt.get(providerId, kind, userId) as number | undefined) ?? 0;
    return rows.map((c) => {
      const rule =
        user.categories.get(c.remoteId) ?? tagRule(user, c.tag) ?? def.categories.get(c.remoteId) ?? tagRule(def, c.tag);
      if (rule !== undefined) return { ...c, visible: rule, isNew: false };
      if (!curated) return { ...c, visible: true, isNew: false };
      const changedAt = Math.max(c.firstSeenAt, c.tagChangedAt);
      return { ...c, visible: false, isNew: c.remoteId !== NONE_ID && changedAt > reviewedAt };
    });
  }

  /** A tag's standing rule for the user: their own, else the default's; absent when neither exists. */
  function tagRulesFor(providerId: number, kind: Kind, userId: number): Map<string, boolean> {
    const out = new Map<string, boolean>();
    const found = (rules.all(providerId, kind, userId) as RuleRow[]).filter((r) => r.targetType === 'tag');
    for (const r of found.filter((x) => x.isDefault)) out.set(r.target, r.visible === 1);
    for (const r of found.filter((x) => !x.isDefault)) out.set(r.target, r.visible === 1);
    return out;
  }

  function resolution(providerId: number, kind: Kind, userId: number): Resolution {
    const rows = categories.all(providerId, kind) as CategoryRow[];
    const resolved = resolve(providerId, kind, userId, rows);
    return {
      visibleIds: new Set(resolved.filter((c) => c.visible).map((c) => c.id)),
      allVisible: resolved.length > 0 && resolved.every((c) => c.visible),
      ...nameFns(rows[0]?.pattern ?? null, resolved),
      newCount: resolved.filter((c) => c.isNew).length,
    };
  }

  function save(providerId: number, kind: Kind, update: CurationUpdate, userId: number | null): void {
    const tagOf = new Map(
      (categories.all(providerId, kind) as CategoryRow[]).map((c) => [c.remoteId, c.tag] as const),
    );
    const tags = new Map(Object.entries(update.tags));
    db.transaction(() => {
      deleteRules.run(providerId, kind, userId);
      for (const [tag, visible] of tags) upsertRule.run(providerId, userId, kind, 'tag', tag, visible ? 1 : 0);
      for (const [remoteId, visible] of Object.entries(update.categories)) {
        // A choice equal to its group's switch is no exception: storing it would pin the category if it changed group.
        const tag = tagOf.get(remoteId) ?? null;
        if (tag !== null && tags.get(tag) === visible) continue;
        upsertRule.run(providerId, userId, kind, 'category', remoteId, visible ? 1 : 0);
      }
      upsertState.run(providerId, userId, kind, deps.now());
    })();
  }

  return {
    view(providerId, kind, userId) {
      const rows = categoriesWithCounts.all(providerId, kind) as (CategoryRow & { itemCount: number })[];
      // A kind with no categories has no style row either; detection calls an empty list untagged.
      const style = rows[0]?.style ?? 'untagged';
      const pattern = rows[0]?.pattern ?? null;
      const resolved = resolve(providerId, kind, userId, rows);
      const { displayName } = nameFns(pattern, resolved);
      const tagRules = tagRulesFor(providerId, kind, userId);
      const groups = new Map<string, CurationGroup>();
      const untagged: CurationCategory[] = [];
      // Rows arrive in provider order, so groups come out in the order of their first category.
      for (const c of resolved) {
        const entry: CurationCategory = {
          id: c.id, remoteId: c.remoteId, name: c.name, displayName: displayName(c.name),
          itemCount: c.itemCount, visible: c.visible, isNew: c.isNew,
        };
        if (c.tag === null) {
          untagged.push(entry);
          continue;
        }
        let group = groups.get(c.tag);
        if (!group) {
          group = { tag: c.tag, friendlyName: friendlyName(c.tag), hint: [], rule: tagRules.get(c.tag) ?? null, categories: [] };
          groups.set(c.tag, group);
        }
        if (group.hint.length < HINT_SIZE) group.hint.push(pattern ? strip(c.name, c.tag, pattern) : c.name);
        group.categories.push(entry);
      }
      return {
        kind,
        style,
        groups: [...groups.values()],
        untagged,
        newCount: resolved.filter((c) => c.isNew).length,
      };
    },

    save,

    hideCategory(categoryId, userId) {
      const c = category.get(categoryId) as { providerId: number; kind: Kind; remoteId: string } | undefined;
      if (!c) return false;
      if (anyRule.get(c.providerId, c.kind, userId) === undefined) {
        // With no rules the kind shows everything, and a lone rule would hide the rest: keep everything else first.
        const update: CurationUpdate = { tags: {}, categories: {} };
        for (const row of categories.all(c.providerId, c.kind) as CategoryRow[]) {
          if (row.tag === null) update.categories[row.remoteId] = true;
          else update.tags[row.tag] = true;
        }
        update.categories[c.remoteId] = false;
        save(c.providerId, c.kind, update, userId);
      } else {
        upsertRule.run(c.providerId, userId, c.kind, 'category', c.remoteId, 0);
      }
      return true;
    },

    resolution,
    visibleCategoryIds: (providerId, kind, userId) => resolution(providerId, kind, userId).visibleIds,
    displayNameFn: (providerId, kind, userId) => resolution(providerId, kind, userId).displayName,
    newCount: (providerId, kind, userId) => resolution(providerId, kind, userId).newCount,
  };
}
