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
    .map((w) => (Object.hasOwn(NUMBERS, w) ? NUMBERS[w]! : w)) // own keys only: "constructor" is inherited
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

type Channels = { key: string; names: string[] }[];

/** What the ladder looks a guide's channels up by. */
type ChannelIndex = {
  keys: Set<string>;
  /** Keys by lower case, each list sorted. */
  byKeyLower: Map<string, string[]>;
  byName: Map<string, Set<string>>;
  byNameLower: Map<string, Set<string>>;
  byNorm: Map<string, Set<string>>;
};

const add = (m: Map<string, Set<string>>, k: string, key: string) => {
  if (k === '') return;
  let set = m.get(k);
  if (!set) m.set(k, (set = new Set()));
  set.add(key);
};

function indexChannels(channels: Channels, norm: Normalise): ChannelIndex {
  const keys = new Set(channels.map((c) => c.key));
  const byKeyLower = new Map<string, string[]>();
  for (const k of [...keys].sort()) {
    const lower = k.toLowerCase();
    const list = byKeyLower.get(lower);
    if (list) list.push(k);
    else byKeyLower.set(lower, [k]);
  }
  const byName = new Map<string, Set<string>>();
  const byNameLower = new Map<string, Set<string>>();
  const byNorm = new Map<string, Set<string>>();
  for (const c of channels) {
    for (const n of c.names) {
      add(byName, n, c.key);
      add(byNameLower, n.toLowerCase(), c.key);
      for (const form of nameForms(n, norm)) add(byNorm, form, c.key);
    }
  }
  return { keys, byKeyLower, byName, byNameLower, byNorm };
}

/**
 * An item's candidates at the ladder's id step (the exact key first, then the others equal ignoring case, smallest
 * first), its display-name step (exact, then ignoring case) and its normalised step. Siblings come after these.
 */
type Candidates = {
  ids: string[];
  names: Set<string> | undefined;
  namesLower: Set<string> | undefined;
  normalised: Set<string>;
};

function candidatesOf(item: MatchItem, norms: Set<string>, index: ChannelIndex): Candidates {
  const key = item.epgChannelId ?? item.name;
  const lower = key.toLowerCase();
  const variants = index.byKeyLower.get(lower) ?? [];
  const ids = index.keys.has(key) ? [key, ...variants.filter((k) => k !== key)] : variants;
  const normalised = new Set<string>();
  for (const n of norms) for (const k of index.byNorm.get(n) ?? []) normalised.add(k);
  return { ids, names: index.byName.get(key), namesLower: index.byNameLower.get(lower), normalised };
}

/**
 * `manual` is keyed by item remote id; the result is keyed by item id. `names` serves and keeps normalised names.
 * A channel with listings has a programme on now or upcoming (`keysWithListings`). A match to one without them (empty,
 * or a stale stub) holds only until a later step finds one with them, which then links with that step's method. A
 * manual map always holds.
 */
export function computeLinks(input: {
  items: MatchItem[];
  channels: Channels;
  manual: Map<string, string>;
  keysWithProgrammes?: Set<string>;
  keysWithListings?: Set<string>;
  names?: NameCache;
}): Map<number, GuideLink> {
  const { items, manual } = input;
  const norm = normaliserFor(input.names);
  const withProgrammes = input.keysWithProgrammes ?? new Set<string>();
  const listed = input.keysWithListings ?? new Set<string>();
  const index = indexChannels(input.channels, norm);

  // Several candidates: a key with listings, then one with programmes, then the `.<tag>` suffix, then the smallest key.
  const pick = (candidates: Iterable<string>, tag: string | null): string | null => {
    let list = [...candidates];
    if (list.length === 0) return null;
    for (const preferred of [listed, withProgrammes]) {
      const kept = list.filter((k) => preferred.has(k));
      if (kept.length > 0) list = kept;
    }
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
    const { own, all: norms } = itemForms(item, norm);
    if (own) normOf.set(item.id, own);

    const manualKey = manual.get(item.remoteId);
    if (manualKey !== undefined && index.keys.has(manualKey)) {
      links.set(item.id, { key: manualKey, method: 'manual' });
      continue;
    }
    // Down the ladder to the first key with listings; failing that, the first key found.
    let first: GuideLink | undefined;
    const settles = (key: string | null | undefined, method: LinkMethod): boolean => {
      if (key == null) return false;
      if (listed.has(key)) {
        links.set(item.id, { key, method });
        return true;
      }
      first ??= { key, method };
      return false;
    };
    const c = candidatesOf(item, norms, index);
    const settled =
      settles(c.ids.find((k) => listed.has(k)) ?? c.ids[0], 'id') ||
      settles(pick(c.names ?? [], item.tag), 'name') ||
      settles(pick(c.namesLower ?? [], item.tag), 'name') ||
      settles(pick(c.normalised, item.tag), 'normalised');
    if (!settled && first) links.set(item.id, first);
  }

  const linkedByNorm = new Map<string, Set<string>>();
  for (const item of items) {
    const link = links.get(item.id);
    const norm = normOf.get(item.id);
    if (link && norm) add(linkedByNorm, norm, link.key);
  }
  for (const item of items) {
    const norm = normOf.get(item.id); // never set for a separator
    if (!norm) continue;
    const link = links.get(item.id);
    if (link && (link.method === 'manual' || listed.has(link.key))) continue;
    // Over a match of its own, only a sibling's key with listings.
    const siblings = [...(linkedByNorm.get(norm) ?? [])].filter((k) => !link || listed.has(k));
    const hit = pick(siblings, item.tag);
    if (hit !== null) links.set(item.id, { key: hit, method: 'sibling' });
  }
  return links;
}

/**
 * Every key the ladder could link each item to, whichever channels turn out to have listings: its manual map, or
 * else its candidates at every step plus its siblings' (sibling inheritance can give it any key they link to), so
 * siblings share one set. Ingest stores programmes for these, so that matching can then see which have listings.
 */
export function linkCandidates(input: {
  items: MatchItem[];
  channels: Channels;
  manual: Map<string, string>;
  names?: NameCache;
}): Map<number, Set<string>> {
  const norm = normaliserFor(input.names);
  const index = indexChannels(input.channels, norm);
  const result = new Map<number, Set<string>>();
  const bySiblings = new Map<string, Set<string>>();
  for (const item of input.items) {
    if (isSeparatorName(item.name)) continue;
    const { own, all: norms } = itemForms(item, norm);
    let shared = own ? bySiblings.get(own) : undefined;
    if (own && !shared) bySiblings.set(own, (shared = new Set()));
    const manualKey = input.manual.get(item.remoteId);
    if (manualKey !== undefined && index.keys.has(manualKey)) {
      shared?.add(manualKey);
      result.set(item.id, new Set([manualKey]));
      continue;
    }
    const keys = shared ?? new Set<string>();
    const c = candidatesOf(item, norms, index);
    for (const step of [c.ids, c.names ?? [], c.namesLower ?? [], c.normalised]) for (const k of step) keys.add(k);
    result.set(item.id, keys);
  }
  return result;
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
  channels: Channels;
  manual: Map<string, string>;
  keysWithProgrammes: Set<string>;
  keysWithListings: Set<string>;
};

/**
 * What matching reads for `generation`, as if it were the current guide with this source. A channel has listings
 * when a programme of it stops after `nowSec`.
 */
function readLinkInputs(db: Db, providerId: number, generation: number, source: GuideSource, nowSec: number): LinkInputs {
  const channels = (
    db.prepare('SELECT key, names FROM guide_channels WHERE provider_id = ? AND generation = ?').all(providerId, generation) as {
      key: string;
      names: string;
    }[]
  ).map((r) => ({ key: r.key, names: JSON.parse(r.names) as string[] }));
  const items = loadMatchItems(db, providerId);
  if (source === 'provider') {
    return { source, items, channels, manual: new Map(), keysWithProgrammes: new Set(), keysWithListings: new Set() };
  }
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
  // A programme that starts later (it stops later too: none is stored with stop <= start) answers for nearly every
  // channel from the index alone. Only without one are the channel's programmes read for one still on, and then it
  // has few. INDEXED BY: left to itself the planner reads that through programmes_stop, every programme of the guide
  // still to stop, once for each channel without listings (minutes for 7,000 of them against 720,000 programmes).
  const keysWithListings = new Set(
    db
      .prepare(
        `SELECT key FROM guide_channels gc WHERE provider_id = @p AND generation = @g
            AND (EXISTS (SELECT 1 FROM programmes p INDEXED BY programmes_slot
                          WHERE p.provider_id = @p AND p.generation = @g AND p.channel_key = gc.key AND p.start > @now)
              OR EXISTS (SELECT 1 FROM programmes p INDEXED BY programmes_slot
                          WHERE p.provider_id = @p AND p.generation = @g AND p.channel_key = gc.key AND p.stop > @now))`,
      )
      .pluck()
      .all({ p: providerId, g: generation, now: nowSec }) as string[],
  );
  return { source, items, channels, manual: loadManualMaps(db, providerId), keysWithProgrammes, keysWithListings };
}

function matchLinks(inputs: LinkInputs, names: NameCache | undefined): Map<number, GuideLink> {
  const { items, channels, manual, keysWithProgrammes, keysWithListings } = inputs;
  if (inputs.source !== 'provider') return computeLinks({ items, channels, manual, keysWithProgrammes, keysWithListings, names });
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

function currentGuide(db: Db, providerId: number): { generation: number; source: GuideSource } {
  const state = db
    .prepare('SELECT generation, source FROM guide_state WHERE provider_id = ?')
    .get(providerId) as { generation: number; source: GuideSource } | undefined;
  return { generation: state?.generation ?? 0, source: state?.source ?? null };
}

const clockSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Re-matches the current guide's channels to live items and replaces the provider's links. Which channels have
 * listings is judged at `nowSec` (epoch seconds), by default the current time.
 */
export function relinkGuide(db: Db, providerId: number, nowSec = clockSec()): RelinkResult {
  const { generation, source } = currentGuide(db, providerId);
  return writeLinks(db, providerId, matchLinks(readLinkInputs(db, providerId, generation, source, nowSec), undefined));
}

/**
 * relinkGuide in steps that yield to the event loop (planLinks), for a large catalogue after a sync, then one
 * transaction that writes the links (applyLinks). If the guide moved to another generation meanwhile, that one is
 * matched in the transaction instead.
 */
export async function relinkGuideInSteps(db: Db, providerId: number, nowSec = clockSec()): Promise<RelinkResult> {
  const names: NameCache = new Map();
  const { generation, source } = currentGuide(db, providerId);
  const plan = await planLinks(db, providerId, generation, source, names, nowSec);
  return db.transaction(() => {
    const current = currentGuide(db, providerId);
    if (current.generation === plan.generation && current.source === plan.source) return applyLinks(db, providerId, plan, names);
    // A commit is a write too, but applyLinks would match the plan's own generation again.
    const inputs = readLinkInputs(db, providerId, current.generation, current.source, nowSec);
    return writeLinks(db, providerId, matchLinks(inputs, names));
  })();
}

/**
 * Links matched ahead of writing them, with the database's write mark from when their inputs were read and the
 * time their listings were judged at.
 */
export type LinkPlan = { generation: number; source: GuideSource; nowSec: number; mark: string; links: Map<number, GuideLink> };

/** Moves on any write to the database: by this connection (total_changes) or by another one (data_version). */
const writeMark = (db: Db): string =>
  `${db.prepare('SELECT total_changes()').pluck().get() as number}:${db.pragma('data_version', { simple: true }) as number}`;

/**
 * Matches for a generation ahead of writing its links. Reading, normalising names (prepareNames, in slices) and
 * matching each take their own turns of the event loop: together, for 50,000 live items, they would block it for
 * 300 ms or more. Listings are judged at `nowSec`.
 */
export async function planLinks(
  db: Db,
  providerId: number,
  generation: number,
  source: GuideSource,
  names: NameCache,
  nowSec: number,
): Promise<LinkPlan> {
  await yieldToEventLoop();
  const mark = writeMark(db);
  const inputs = readLinkInputs(db, providerId, generation, source, nowSec);
  await yieldToEventLoop();
  if (source !== 'provider') await prepareNames(inputs.items, inputs.channels, names);
  const links = matchLinks(inputs, names);
  await yieldToEventLoop();
  return { generation, source, nowSec, mark, links };
}

/**
 * Writes a plan's links. Run it inside a transaction, before any other write there (as when committing the plan's
 * generation). If anything was written since the plan read its inputs (a catalogue sync, a manual pick), it matches
 * again from the database first, so the links are never stale.
 */
export function applyLinks(db: Db, providerId: number, plan: LinkPlan, names: NameCache): RelinkResult {
  const fresh = writeMark(db) === plan.mark;
  const links = fresh ? plan.links : matchLinks(readLinkInputs(db, providerId, plan.generation, plan.source, plan.nowSec), names);
  return writeLinks(db, providerId, links);
}
