import type { Db } from '../db/db.ts';
import { stripTag, tagOf } from '../curation/tags.ts';
import type { TagPattern } from '../curation/tags.ts';

export type LinkMethod = 'manual' | 'id' | 'name' | 'normalised' | 'sibling' | 'provider';
export type MatchItem = { id: number; remoteId: string; name: string; epgChannelId: string | null; tag: string | null };
export type GuideLink = { key: string; method: LinkMethod };

const PATTERNS: TagPattern[] = ['pipe', 'pipe-wrapped', 'bracket', 'dash', 'colon'];
const NOISE = new Set(
  'hd fhd uhd sd 4k 8k hevc h265 h264 hdr sdr 50fps 60fps 1080p 1080i 720p 2160p raw backup vip'.split(' '),
);
const NUMBERS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5' };

/** Lower-case, accent-free, quality-free form of a channel name, so "BBC 1 HD" and "BBC One" compare equal. */
export function normaliseChannelName(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[([]([^)\]]*)[)\]]/g, (m, inner: string) =>
      inner.split(/[^a-z0-9]+/).every((w) => w === '' || NOISE.has(w)) ? ' ' : m,
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s
    .split(' ')
    .filter((w) => w !== '' && !NOISE.has(w))
    .map((w) => NUMBERS[w] ?? w)
    .join(' ');
}

export function isSeparatorName(name: string): boolean {
  return /^\s*(?:[#=*-]\s*){3,}/.test(name);
}

/** Strips the item's own category tag, whichever pattern the name uses. */
function stripItemTag(name: string, tag: string | null): string {
  if (!tag) return name;
  for (const p of PATTERNS) {
    const stripped = stripTag(name, tag, p);
    if (stripped !== name) return stripped;
  }
  return name;
}

/** Strips a leading tag of any known pattern; the provider writes its tagged names as display-names. */
function stripAnyTag(name: string): string {
  for (const p of PATTERNS) {
    const tag = tagOf(name, p);
    if (tag) return stripTag(name, tag, p);
  }
  return name;
}

/** `manual` is keyed by item remote id; the result is keyed by item id. */
export function computeLinks(input: {
  items: MatchItem[];
  channels: { key: string; names: string[] }[];
  manual: Map<string, string>;
  keysWithProgrammes?: Set<string>;
}): Map<number, GuideLink> {
  const { items, channels, manual } = input;
  const withProgrammes = input.keysWithProgrammes ?? new Set<string>();
  const keys = new Set(channels.map((c) => c.key));
  const sortedKeys = [...keys].sort();

  const byKey = new Map<string, string>();
  const byKeyLower = new Map<string, string>();
  for (const k of sortedKeys) {
    byKey.set(k, k);
    if (!byKeyLower.has(k.toLowerCase())) byKeyLower.set(k.toLowerCase(), k);
  }
  const byName = new Map<string, Set<string>>();
  const byNameLower = new Map<string, Set<string>>();
  const byNorm = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, key: string) => {
    if (k === '') return;
    let set = m.get(k);
    if (!set) m.set(k, (set = new Set()));
    set.add(key);
  };
  for (const c of channels) {
    for (const n of c.names) {
      add(byName, n, c.key);
      add(byNameLower, n.toLowerCase(), c.key);
      add(byNorm, normaliseChannelName(stripAnyTag(n)), c.key);
    }
  }

  // Several candidates: a key with programmes, then the `.<tag>` suffix, then the smallest key.
  const pick = (candidates: Iterable<string>, tag: string | null): string | null => {
    let list = [...candidates];
    if (list.length === 0) return null;
    const live = list.filter((k) => withProgrammes.has(k));
    if (live.length > 0) list = live;
    if (tag) {
      const suffix = `.${tag.toLowerCase()}`;
      const tagged = list.filter((k) => k.toLowerCase().endsWith(suffix));
      if (tagged.length > 0) list = tagged;
    }
    return list.sort()[0]!;
  };

  const links = new Map<number, GuideLink>();
  const normOf = new Map<number, string>();
  for (const item of items) {
    if (isSeparatorName(item.name)) continue;
    const key = item.epgChannelId ?? item.name;
    const norms = new Set<string>();
    const own = normaliseChannelName(stripItemTag(item.name, item.tag));
    if (own) {
      norms.add(own);
      normOf.set(item.id, own);
    }
    if (item.epgChannelId) {
      const fromId = normaliseChannelName(item.epgChannelId);
      if (fromId) norms.add(fromId);
    }

    const manualKey = manual.get(item.remoteId);
    if (manualKey !== undefined && keys.has(manualKey)) {
      links.set(item.id, { key: manualKey, method: 'manual' });
      continue;
    }
    const idHit = byKey.get(key) ?? byKeyLower.get(key.toLowerCase());
    if (idHit !== undefined) {
      links.set(item.id, { key: idHit, method: 'id' });
      continue;
    }
    const nameHit = pick(byName.get(key) ?? byNameLower.get(key.toLowerCase()) ?? [], item.tag);
    if (nameHit !== null) {
      links.set(item.id, { key: nameHit, method: 'name' });
      continue;
    }
    const candidates = new Set<string>();
    for (const n of norms) for (const k of byNorm.get(n) ?? []) candidates.add(k);
    const normHit = pick(candidates, item.tag);
    if (normHit !== null) links.set(item.id, { key: normHit, method: 'normalised' });
  }

  const linkedByNorm = new Map<string, Set<string>>();
  for (const item of items) {
    const link = links.get(item.id);
    const norm = normOf.get(item.id);
    if (link && norm) add(linkedByNorm, norm, link.key);
  }
  for (const item of items) {
    if (links.has(item.id) || isSeparatorName(item.name)) continue;
    const norm = normOf.get(item.id);
    const hit = norm ? pick(linkedByNorm.get(norm) ?? [], item.tag) : null;
    if (hit !== null) links.set(item.id, { key: hit, method: 'sibling' });
  }
  return links;
}

/** Live items with the tag of their first category (by category position). */
export function loadMatchItems(db: Db, providerId: number): MatchItem[] {
  return db
    .prepare(
      `SELECT i.id, i.remote_id AS remoteId, i.name, i.epg_channel_id AS epgChannelId,
              (SELECT c.tag FROM item_categories ic JOIN categories c ON c.id = ic.category_id
                WHERE ic.item_id = i.id ORDER BY c.position, c.id LIMIT 1) AS tag
         FROM items i WHERE i.provider_id = ? AND i.kind = 'live' ORDER BY i.id`,
    )
    .all(providerId) as MatchItem[];
}

/** Manual guide picks: item remote id to channel key. */
export function loadManualMaps(db: Db, providerId: number): Map<string, string> {
  const rows = db
    .prepare('SELECT item_remote_id AS remoteId, channel_key AS channelKey FROM guide_maps WHERE provider_id = ?')
    .all(providerId) as { remoteId: string; channelKey: string }[];
  return new Map(rows.map((r) => [r.remoteId, r.channelKey]));
}

const METHODS: LinkMethod[] = ['manual', 'id', 'name', 'normalised', 'sibling', 'provider'];

export function relinkGuide(db: Db, providerId: number): { linked: number; byMethod: Record<LinkMethod, number> } {
  const state = db
    .prepare('SELECT generation, source FROM guide_state WHERE provider_id = ?')
    .get(providerId) as { generation: number; source: string | null } | undefined;
  const generation = state?.generation ?? 0;
  const channels = (
    db.prepare('SELECT key, names FROM guide_channels WHERE provider_id = ? AND generation = ?').all(providerId, generation) as {
      key: string;
      names: string;
    }[]
  ).map((r) => ({ key: r.key, names: JSON.parse(r.names) as string[] }));
  const items = loadMatchItems(db, providerId);

  let links: Map<number, GuideLink>;
  if (state?.source === 'provider') {
    const keys = new Set(channels.map((c) => c.key));
    links = new Map();
    for (const item of items) {
      const key = `stream:${item.remoteId}`;
      if (keys.has(key)) links.set(item.id, { key, method: 'provider' });
    }
  } else {
    const keysWithProgrammes = new Set(
      (
        db
          .prepare('SELECT DISTINCT channel_key AS k FROM programmes WHERE provider_id = ? AND generation = ?')
          .all(providerId, generation) as { k: string }[]
      ).map((r) => r.k),
    );
    links = computeLinks({ items, channels, manual: loadManualMaps(db, providerId), keysWithProgrammes });
  }

  const byMethod = Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<LinkMethod, number>;
  const insert = db.prepare('INSERT INTO guide_links (item_id, provider_id, channel_key, method) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM guide_links WHERE provider_id = ?').run(providerId);
    for (const [itemId, link] of links) {
      insert.run(itemId, providerId, link.key, link.method);
      byMethod[link.method]++;
    }
  })();
  return { linked: links.size, byMethod };
}
