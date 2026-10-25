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
      inner.split(/[^\p{L}\p{N}]+/u).every((w) => w === '' || NOISE.has(w)) ? ' ' : m,
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

/** Strips the item's own category tag, whichever pattern the name uses; else any known leading tag. */
function stripItemTag(name: string, tag: string | null): string {
  if (tag) {
    for (const p of PATTERNS) {
      const stripped = stripTag(name, tag, p);
      if (stripped !== name) return stripped;
    }
  }
  return stripAnyTag(name);
}

/** Strips a leading tag of any known pattern; the provider writes its tagged names as display-names. */
function stripAnyTag(name: string): string {
  for (const p of PATTERNS) {
    const tag = tagOf(name, p);
    if (tag) return stripTag(name, tag, p);
  }
  return name;
}

/** Normalised channel names by name, kept for one refresh so its matching passes normalise each name once. */
export type NameCache = Map<string, string>;
type Normalise = (name: string) => string;

const PREPARE_SLICE = 2000;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function normaliserFor(cache: NameCache | undefined): Normalise {
  if (!cache) return normaliseChannelName;
  return (name) => {
    let norm = cache.get(name);
    if (norm === undefined) cache.set(name, (norm = normaliseChannelName(name)));
    return norm;
  };
}

/** Both forms: the colon and dash patterns are loose, so "Sky: Sports" must stay findable as itself. */
const nameForms = (name: string, norm: Normalise): string[] => [norm(name), norm(stripAnyTag(name))];

/** `own` is the name without the item's own tag, which siblings share; `all` adds the raw name and the guide id. */
function itemForms(item: MatchItem, norm: Normalise): { own: string; all: Set<string> } {
  const own = norm(stripItemTag(item.name, item.tag));
  const all = new Set([own, norm(item.name)]);
  if (item.epgChannelId) all.add(norm(item.epgChannelId));
  all.delete('');
  return { own, all };
}

/**
 * Normalises into `cache` every name that matching these items against these channels looks up, yielding to the event
 * loop between slices. Normalising is most of what computeLinks costs (about 180 of 300 ms for 50,000 items), so with
 * a prepared cache a refresh's matching passes each stay short.
 */
export async function prepareNames(items: MatchItem[], channels: { names: string[] }[], cache: NameCache): Promise<void> {
  const norm = normaliserFor(cache);
  let done = 0;
  for (const c of channels) {
    for (const n of c.names) {
      nameForms(n, norm);
      if (++done % PREPARE_SLICE === 0) await yieldToEventLoop();
    }
  }
  for (const item of items) {
    if (!isSeparatorName(item.name)) itemForms(item, norm);
    if (++done % PREPARE_SLICE === 0) await yieldToEventLoop();
  }
}

/** `manual` is keyed by item remote id; the result is keyed by item id. `names` serves and keeps normalised names. */
export function computeLinks(input: {
  items: MatchItem[];
  channels: { key: string; names: string[] }[];
  manual: Map<string, string>;
  keysWithProgrammes?: Set<string>;
  names?: NameCache;
}): Map<number, GuideLink> {
  const { items, channels, manual } = input;
  const norm = normaliserFor(input.names);
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
      for (const form of nameForms(n, norm)) add(byNorm, form, c.key);
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
    const { own, all: norms } = itemForms(item, norm);
    if (own) normOf.set(item.id, own);

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
  // One sorted join, keeping each item's first row: a subquery per item sorts each item's categories on its own,
  // which for 50,000 items took 80 ms against 50.
  const rows = db
    .prepare(
      `SELECT i.id, i.remote_id AS remoteId, i.name, i.epg_channel_id AS epgChannelId, c.tag
         FROM items i
         LEFT JOIN item_categories ic ON ic.item_id = i.id
         LEFT JOIN categories c ON c.id = ic.category_id
        WHERE i.provider_id = ? AND i.kind = 'live'
        ORDER BY i.id, c.position, c.id`,
    )
    .all(providerId) as MatchItem[];
  return rows.filter((r, i) => i === 0 || rows[i - 1]!.id !== r.id);
}

/** Manual guide picks: item remote id to channel key. */
export function loadManualMaps(db: Db, providerId: number): Map<string, string> {
  const rows = db
    .prepare('SELECT item_remote_id AS remoteId, channel_key AS channelKey FROM guide_maps WHERE provider_id = ?')
    .all(providerId) as { remoteId: string; channelKey: string }[];
  return new Map(rows.map((r) => [r.remoteId, r.channelKey]));
}

const METHODS: LinkMethod[] = ['manual', 'id', 'name', 'normalised', 'sibling', 'provider'];

type GuideSource = 'xmltv' | 'provider' | null;
type RelinkResult = { linked: number; byMethod: Record<LinkMethod, number> };
type LinkInputs = {
  source: GuideSource;
  items: MatchItem[];
  channels: { key: string; names: string[] }[];
  manual: Map<string, string>;
  keysWithProgrammes: Set<string>;
};

/** What matching reads for `generation`, as if it were the current guide with this source. */
function readLinkInputs(db: Db, providerId: number, generation: number, source: GuideSource): LinkInputs {
  const channels = (
    db.prepare('SELECT key, names FROM guide_channels WHERE provider_id = ? AND generation = ?').all(providerId, generation) as {
      key: string;
      names: string;
    }[]
  ).map((r) => ({ key: r.key, names: JSON.parse(r.names) as string[] }));
  const items = loadMatchItems(db, providerId);
  if (source === 'provider') return { source, items, channels, manual: new Map(), keysWithProgrammes: new Set() };
  // Only declared channels can be picked, so only they are checked: a probe each rather than a scan of the guide.
  const keysWithProgrammes = new Set(
    db
      .prepare(
        `SELECT key FROM guide_channels gc WHERE provider_id = @p AND generation = @g
            AND EXISTS (SELECT 1 FROM programmes p WHERE p.provider_id = @p AND p.generation = @g AND p.channel_key = gc.key)`,
      )
      .pluck()
      .all({ p: providerId, g: generation }) as string[],
  );
  return { source, items, channels, manual: loadManualMaps(db, providerId), keysWithProgrammes };
}

function matchLinks(inputs: LinkInputs, names: NameCache | undefined): Map<number, GuideLink> {
  const { items, channels, manual, keysWithProgrammes } = inputs;
  if (inputs.source !== 'provider') return computeLinks({ items, channels, manual, keysWithProgrammes, names });
  const keys = new Set(channels.map((c) => c.key));
  const links = new Map<number, GuideLink>();
  for (const item of items) {
    const key = `stream:${item.remoteId}`;
    if (keys.has(key) && !isSeparatorName(item.name)) links.set(item.id, { key, method: 'provider' });
  }
  return links;
}

function writeLinks(db: Db, providerId: number, links: Map<number, GuideLink>): RelinkResult {
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

/** Re-matches the current guide's channels to live items and replaces the provider's links. */
export function relinkGuide(db: Db, providerId: number): RelinkResult {
  const state = db
    .prepare('SELECT generation, source FROM guide_state WHERE provider_id = ?')
    .get(providerId) as { generation: number; source: GuideSource } | undefined;
  const inputs = readLinkInputs(db, providerId, state?.generation ?? 0, state?.source ?? null);
  return writeLinks(db, providerId, matchLinks(inputs, undefined));
}

/** Links matched ahead of their generation's commit, with the database's write mark when their inputs were read. */
export type LinkPlan = { generation: number; source: 'xmltv' | 'provider'; mark: string; links: Map<number, GuideLink> };

/** Moves on any write to the database: by this connection (total_changes) or by another one (data_version). */
const writeMark = (db: Db): string =>
  `${db.prepare('SELECT total_changes()').pluck().get() as number}:${db.pragma('data_version', { simple: true }) as number}`;

/**
 * Matches for a generation before it is committed, so the commit's transaction only writes. Reading and matching each
 * take their own turn of the event loop: together, for 50,000 live items, they would block it for about 200 ms.
 */
export async function planLinks(
  db: Db,
  providerId: number,
  generation: number,
  source: 'xmltv' | 'provider',
  names: NameCache,
): Promise<LinkPlan> {
  await yieldToEventLoop();
  const mark = writeMark(db);
  const inputs = readLinkInputs(db, providerId, generation, source);
  await yieldToEventLoop();
  const links = matchLinks(inputs, names);
  await yieldToEventLoop();
  return { generation, source, mark, links };
}

/**
 * Writes a plan's links; run it in the transaction that commits the plan's generation, before the commit's own write.
 * If anything was written since the plan read its inputs (a catalogue sync, a manual pick), it matches again from the
 * database, so the links are never stale.
 */
export function applyLinks(db: Db, providerId: number, plan: LinkPlan, names: NameCache): RelinkResult {
  const fresh = writeMark(db) === plan.mark;
  const links = fresh ? plan.links : matchLinks(readLinkInputs(db, providerId, plan.generation, plan.source), names);
  return writeLinks(db, providerId, links);
}
