import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { CurationCategory, CurationUpdate, CurationView } from '@tv/shared';
import type { FakeCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';
import { startFakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import type { FakeXtream } from '../../../tools/fake-xtream/src/server.ts';
import { syncCatalogue } from '../catalogue/sync.ts';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createProviderService } from '../providers/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { DEFAULT_USER_ID } from '../users.ts';
import { createCurationService } from './service.ts';
import type { CurationService } from './service.ts';

const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/fake-xtream/media');
const OWNER = DEFAULT_USER_ID;
const GUEST = 2;

type Cat = [remoteId: string, name: string];

/** Three tag groups, interleaved as providers list them, plus one untagged category. */
const BASE: Cat[] = [
  ['11', 'UK| SPORTS'],
  ['21', 'US| SPORTS'],
  ['12', 'UK| NEWS'],
  ['31', 'AR| MBC'],
  ['22', 'US| NEWS'],
  ['32', 'AR| ROTANA'],
  ['13', 'UK| PPV'],
  ['41', 'MISC'],
  ['33', 'AR| ART'],
  ['34', 'AR| NILE'],
];
const ALL = BASE.map(([id]) => id);
const UK = ['11', '12', '13'];
const UK_ONLY: CurationUpdate = { tags: { UK: true, US: false, AR: false }, categories: {} };
const UK_US: CurationUpdate = { tags: { UK: true, US: true, AR: false }, categories: {} };

/** One channel per category and a second in the first; `orphan` adds a channel in a category the provider does not list. */
function catalogue(cats: Cat[], opts: { orphan?: boolean }): FakeCatalogue {
  const items = cats.map(([categoryId, name], i) => ({ id: i + 1, name: `${name} channel`, categoryId }));
  items.push({ id: 500, name: 'Second channel', categoryId: cats[0]![0] });
  if (opts.orphan) items.push({ id: 900, name: 'Orphan channel', categoryId: 'unlisted' });
  return {
    live: { categories: cats.map(([id, name]) => ({ id, name })), items },
    movie: { categories: [], items: [] },
    series: { categories: [], items: [] },
    episodes: {},
  };
}

let fake: FakeXtream;
let db: Db;
let providers: ProviderService;
let providerId: number;
let clock: number;
let curation: CurationService;

beforeAll(async () => {
  fake = await startFakeXtream({ mediaDir });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  clock = 1_000_000;
  db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (?, 'Guest', 0)").run(GUEST);
  providers = createProviderService({ db, userAgent: 'test-agent' });
  providerId = (await providers.add({ kind: 'xtream', serverUrl: fake.url, username: 'u', password: 'p' })).id;
  curation = createCurationService({ db, now: () => clock });
  await sync(BASE);
});

// Every sync and save happens a minute after the step before it, as on a real server.
async function sync(cats: Cat[], opts: { orphan?: boolean } = {}): Promise<void> {
  fake.setCatalogue(catalogue(cats, opts));
  clock += 60_000;
  await syncCatalogue({ db, client: providers.clientFor(providerId), providerId, kinds: ['live'], now: () => clock });
}
function save(update: CurationUpdate, userId: number | null = null): void {
  clock += 60_000;
  curation.save(providerId, 'live', update, userId);
}

const rows = () =>
  db
    .prepare("SELECT id, remote_id AS remoteId FROM categories WHERE provider_id = ? AND kind = 'live' ORDER BY position, id")
    .all(providerId) as { id: number; remoteId: string }[];
const idOf = (remoteId: string): number => rows().find((r) => r.remoteId === remoteId)!.id;
/** Remote ids of the categories the user sees, in provider order. */
function visible(userId = OWNER): string[] {
  const ids = curation.visibleCategoryIds(providerId, 'live', userId);
  return rows().filter((r) => ids.has(r.id)).map((r) => r.remoteId);
}
const newCount = (userId = OWNER) => curation.newCount(providerId, 'live', userId);
const view = (userId = OWNER): CurationView => curation.view(providerId, 'live', userId);
const everyCategory = (v: CurationView): CurationCategory[] => [...v.groups.flatMap((g) => g.categories), ...v.untagged];
const flags = (cats: CurationCategory[]) => cats.map((c) => [c.remoteId, c.visible, c.isNew]);
const rulesOf = (userId: number | null) =>
  db
    .prepare(
      `SELECT target_type AS type, target, visible FROM category_rules
        WHERE provider_id = ? AND kind = 'live' AND user_id IS ? ORDER BY target_type, target`,
    )
    .all(providerId, userId);

test('an uncurated kind shows everything', async () => {
  await sync(BASE, { orphan: true });
  expect(visible()).toEqual([...ALL, '__none__']);
  expect(newCount()).toBe(0);
  const v = view();
  expect(v.newCount).toBe(0);
  expect(everyCategory(v).every((c) => c.visible && !c.isNew)).toBe(true);
});

test('a tag switch is a standing rule', async () => {
  save(UK_ONLY);
  expect(visible()).toEqual(UK);
  await sync([...BASE, ['14', 'UK| NEW ONE'], ['23', 'US| NEW']]);
  expect(visible()).toEqual([...UK, '14']);
  expect(newCount()).toBe(0);
  expect(flags(view().groups.find((g) => g.tag === 'US')!.categories)).toEqual([
    ['21', false, false],
    ['22', false, false],
    ['23', false, false],
  ]);
});

test('single-category exceptions survive refreshes', async () => {
  save({ ...UK_ONLY, categories: { '13': false, '22': true } });
  expect(visible()).toEqual(['11', '12', '22']);
  await sync([...BASE, ['14', 'UK| NEW ONE']]);
  expect(visible()).toEqual(['11', '12', '22', '14']);
});

test('new untagged categories start hidden and count as new', async () => {
  save(UK_ONLY);
  expect(newCount()).toBe(0); // MISC was on the list when it was reviewed
  // Orphans bring back Uncategorised, which comes and goes with them and so never counts as new.
  await sync([...BASE, ['42', 'MISC NEW']], { orphan: true });
  expect(visible()).toEqual(UK);
  expect(newCount()).toBe(1);
  const v = view();
  expect(v.newCount).toBe(1);
  expect(flags(v.untagged)).toEqual([
    ['41', false, false],
    ['42', false, true],
    ['__none__', false, false],
  ]);
  save(UK_ONLY);
  expect(newCount()).toBe(0);
  expect(visible()).toEqual(UK);
});

test('a new tag group with no rule starts hidden and counts as new', async () => {
  save(UK_ONLY);
  await sync([...BASE, ['51', 'DE| X'], ['52', 'DE| Y']]);
  expect(visible()).toEqual(UK);
  expect(newCount()).toBe(2);
  expect(flags(view().groups.find((g) => g.tag === 'DE')!.categories)).toEqual([
    ['51', false, true],
    ['52', false, true],
  ]);
});

test('a category whose group shrinks to one loses its tag and counts as new', async () => {
  save(UK_US);
  expect(visible()).toEqual(['11', '21', '12', '22', '13']);
  // 21 is left as the only US category, so it is no longer tagged and no rule covers it.
  await sync(BASE.filter(([id]) => id !== '22'));
  expect(visible()).toEqual(UK);
  expect(newCount()).toBe(1);
  expect(flags(view().untagged)).toEqual([
    ['21', false, true],
    ['41', false, false],
  ]);
});

test('a rename into a tag group with no rule counts as new', async () => {
  save(UK_US);
  // 21 moves from US (on) to DE, which arrives with it and has no rule; a new US category keeps US a group.
  await sync([
    ...BASE.map(([id, name]): Cat => [id, id === '21' ? 'DE| SPORTS' : name]),
    ['51', 'DE| Y'],
    ['23', 'US| NEW'],
  ]);
  expect(visible()).toEqual(['11', '12', '22', '13', '23']);
  expect(newCount()).toBe(2);
  expect(flags(view().groups.find((g) => g.tag === 'DE')!.categories)).toEqual([
    ['21', false, true],
    ['51', false, true],
  ]);
});

test('a resync that changes the tag pattern puts the stranded categories up for review', async () => {
  save(UK_ONLY);
  // Ten bracket-tagged categories outnumber the nine pipe-tagged ones, so the pattern flips and the old tags vanish.
  const bracket = Array.from({ length: 10 }, (_, i): Cat => [String(60 + i), `[${i < 5 ? 'DE' : 'FR'}] TOPIC ${i}`]);
  await sync([...BASE, ...bracket]);
  expect(db.prepare("SELECT pattern FROM catalogue_styles WHERE kind = 'live'").pluck().get()).toBe('bracket');
  expect(visible()).toEqual([]);
  // Nothing goes dark silently: everything is new except MISC, which was reviewed and has not changed.
  expect(newCount()).toBe(BASE.length - 1 + bracket.length);
  expect(everyCategory(view()).filter((c) => !c.isNew).map((c) => c.remoteId)).toEqual(['41']);
});

test('rename keeps the exception', async () => {
  save({ ...UK_ONLY, categories: { '12': false } });
  await sync(BASE.map(([id, name]): Cat => [id, id === '12' ? 'UK| NEWS HD' : name]));
  expect(visible()).toEqual(['11', '13']);
  expect(everyCategory(view()).find((c) => c.remoteId === '12')).toMatchObject({ name: 'UK| NEWS HD', visible: false });
});

test('retag follows the new group', async () => {
  save(UK_ONLY);
  expect(visible()).toEqual(UK);
  // 21 moves from US to UK and 12 from UK to US; neither has an exception.
  await sync(
    BASE.map(([id, name]): Cat => [id, id === '21' ? 'UK| SPORTS EXTRA' : id === '12' ? 'US| NEWS 2' : name]),
  );
  expect(visible()).toEqual(['11', '21', '13']);
});

test('save stores only exceptions that differ from their group', () => {
  save({
    tags: { UK: true, US: false },
    categories: { '11': true, '13': false, '21': false, '22': true, '31': false, '41': true },
  });
  expect(rulesOf(null)).toEqual([
    { type: 'category', target: '13', visible: 0 },
    { type: 'category', target: '22', visible: 1 },
    { type: 'category', target: '31', visible: 0 }, // AR has no switch to follow
    { type: 'category', target: '41', visible: 1 }, // untagged: no group at all
    { type: 'tag', target: 'UK', visible: 1 },
    { type: 'tag', target: 'US', visible: 0 },
  ]);
  // A later save replaces the scope's rules rather than adding to them.
  save({ tags: { UK: true }, categories: {} });
  expect(rulesOf(null)).toEqual([{ type: 'tag', target: 'UK', visible: 1 }]);
  expect(db.prepare('SELECT saved_at FROM curation_state WHERE provider_id = ?').pluck().all(providerId)).toEqual([clock]);
});

test('per-user overrides win over defaults and inherit the rest', () => {
  // With no defaults, a user's own rule curates the kind for that user only.
  save({ tags: { US: true }, categories: {} }, OWNER);
  expect(visible(OWNER)).toEqual(['21', '22']);
  expect(visible(GUEST)).toEqual(ALL);

  save({ tags: { UK: true, US: false }, categories: {} });
  expect(visible(OWNER)).toEqual(['11', '21', '12', '22', '13']);
  expect(visible(GUEST)).toEqual(UK);

  // A later default change reaches the user for everything the user has not overridden.
  save({ tags: { UK: true, US: false, AR: true }, categories: {} });
  expect(visible(OWNER)).toEqual(['11', '21', '12', '31', '22', '32', '13', '33', '34']);
  expect(visible(GUEST)).toEqual(['11', '12', '31', '32', '13', '33', '34']);

  // A user's single-category choice beats every default and reaches only that user.
  save({ tags: { US: true }, categories: { '31': false } }, OWNER);
  expect(curation.hideCategory(idOf('11'), OWNER)).toBe(true);
  expect(visible(OWNER)).toEqual(['21', '12', '22', '32', '13', '33', '34']);
  expect(visible(GUEST)).toEqual(['11', '12', '31', '32', '13', '33', '34']);
  expect(rulesOf(OWNER)).toEqual([
    { type: 'category', target: '11', visible: 0 },
    { type: 'category', target: '31', visible: 0 },
    { type: 'tag', target: 'US', visible: 1 },
  ]);
  expect(rulesOf(null)).toEqual([
    { type: 'tag', target: 'AR', visible: 1 },
    { type: 'tag', target: 'UK', visible: 1 },
    { type: 'tag', target: 'US', visible: 0 },
  ]);
});

test("a user's own review time decides what is new, else the default's", async () => {
  save({ tags: { US: true }, categories: {} }, OWNER);
  save(UK_ONLY);
  await sync([...BASE, ['42', 'MISC NEW']]);
  expect(newCount(OWNER)).toBe(1);
  expect(newCount(GUEST)).toBe(1);
  save(UK_ONLY);
  expect(newCount(OWNER)).toBe(1); // the owner's own last review predates MISC NEW
  expect(newCount(GUEST)).toBe(0); // no rules of their own: the default review counts
  save({ tags: { US: true }, categories: {} }, OWNER);
  expect(newCount(OWNER)).toBe(0);
});

test('display names strip the single visible tag', () => {
  // A kept untagged category is not a second tag.
  save({ ...UK_ONLY, categories: { '41': true } });
  const name = curation.displayNameFn(providerId, 'live', OWNER);
  expect(name('UK| SPORTS')).toBe('SPORTS');
  expect(name(' UK| SPORTS')).toBe('SPORTS');
  expect(name('UK| BBC One HD')).toBe('BBC One HD'); // channel names too
  expect(name('US| NEWS')).toBe('US| NEWS');
  expect(name('MISC')).toBe('MISC');
  expect(name('UK|')).toBe('UK|'); // nothing left after the tag: keep the name
  expect(view().groups[0]!.categories.map((c) => c.displayName)).toEqual(['SPORTS', 'NEWS', 'PPV']);

  save({ tags: { UK: true, US: true, AR: false }, categories: {} });
  expect(curation.displayNameFn(providerId, 'live', OWNER)('UK| SPORTS')).toBe('UK| SPORTS');
  expect(view().groups[0]!.categories[0]!.displayName).toBe('UK| SPORTS');
});

test('resolution agrees with visibleCategoryIds, displayNameFn and newCount', async () => {
  save({ ...UK_ONLY, categories: { '13': false } });
  await sync([...BASE, ['42', 'MISC NEW']]);
  const r = curation.resolution(providerId, 'live', OWNER);
  expect(r.visibleIds).toEqual(curation.visibleCategoryIds(providerId, 'live', OWNER));
  expect(r.visibleIds).toEqual(new Set([idOf('11'), idOf('12')]));
  expect(r.newCount).toBe(curation.newCount(providerId, 'live', OWNER));
  expect(r.newCount).toBe(1);
  const name = curation.displayNameFn(providerId, 'live', OWNER);
  for (const n of ['UK| SPORTS', 'US| NEWS', 'MISC', 'UK|']) expect(r.displayName(n)).toBe(name(n));
  expect(r.displayName('UK| SPORTS')).toBe('SPORTS');
});

test('view groups by tag with friendly names and hints', async () => {
  await sync(BASE, { orphan: true });
  const v = view();
  expect(v.kind).toBe('live');
  expect(v.style).toBe('tagged');
  expect(v.newCount).toBe(0);
  // Groups come in the provider order of their first category; categories keep provider order.
  expect(v.groups.map((g) => [g.tag, g.friendlyName, g.hint])).toEqual([
    ['UK', 'United Kingdom', ['SPORTS', 'NEWS', 'PPV']],
    ['US', 'United States', ['SPORTS', 'NEWS']],
    ['AR', null, ['MBC', 'ROTANA', 'ART']],
  ]);
  expect(v.groups[0]!.categories).toEqual([
    { id: idOf('11'), remoteId: '11', name: 'UK| SPORTS', displayName: 'UK| SPORTS', itemCount: 2, visible: true, isNew: false },
    { id: idOf('12'), remoteId: '12', name: 'UK| NEWS', displayName: 'UK| NEWS', itemCount: 1, visible: true, isNew: false },
    { id: idOf('13'), remoteId: '13', name: 'UK| PPV', displayName: 'UK| PPV', itemCount: 1, visible: true, isNew: false },
  ]);
  expect(v.groups[2]!.categories.map((c) => c.remoteId)).toEqual(['31', '32', '33', '34']);
  expect(v.untagged.map((c) => [c.remoteId, c.name, c.itemCount])).toEqual([
    ['41', 'MISC', 1],
    ['__none__', 'Uncategorised', 1],
  ]);
});

test('hiding a category in an uncurated kind hides only that category', async () => {
  expect(curation.hideCategory(idOf('12'), null)).toBe(true);
  expect(visible()).toEqual(ALL.filter((id) => id !== '12'));
  expect(newCount()).toBe(0);
  // Everything else is now kept by standing rules: a new UK category shows and the hidden one stays hidden.
  await sync([...BASE, ['14', 'UK| NEW ONE']]);
  expect(visible()).toEqual([...ALL.filter((id) => id !== '12'), '14']);
});

test('hiding a category in a curated kind adds one exception', async () => {
  save(UK_ONLY);
  expect(curation.hideCategory(idOf('11'), null)).toBe(true);
  expect(visible()).toEqual(['12', '13']);
  expect(rulesOf(null)).toEqual([
    { type: 'category', target: '11', visible: 0 },
    { type: 'tag', target: 'AR', visible: 0 },
    { type: 'tag', target: 'UK', visible: 1 },
    { type: 'tag', target: 'US', visible: 0 },
  ]);
  await sync(BASE);
  expect(visible()).toEqual(['12', '13']);
  expect(curation.hideCategory(987_654, null)).toBe(false);
});
