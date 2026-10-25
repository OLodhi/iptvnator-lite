import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createGuideStore } from './store.ts';
import {
  applyLinks, computeLinks, isSeparatorName, loadMatchItems, normaliseChannelName, planLinks, prepareNames, relinkGuide,
} from './match.ts';
import type { MatchItem } from './match.ts';

const item = (id: number, name: string, extra: Partial<MatchItem> = {}): MatchItem => ({
  id, remoteId: `r${id}`, name, epgChannelId: null, tag: null, ...extra,
});
const ch = (key: string, ...names: string[]) => ({ key, names });
const run = (items: MatchItem[], channels: { key: string; names: string[] }[], manual = new Map<string, string>(), extra = {}) =>
  computeLinks({ items, channels, manual, ...extra });

describe('normaliseChannelName', () => {
  test('normalised names match BBC 1 to BBC One', () => {
    const table: [string, string][] = [
      ['BBC 1 HD', 'bbc 1'], ['BBC One', 'bbc 1'], ['ITV +1', 'itv plus 1'], ['ITV+1', 'itv plus 1'],
      ['Sky Sports Main Event ᴴᴰ', 'sky sports main event'], ['Film4 +1 HEVC', 'film4 plus 1'],
      ['4Music', '4music'], ['E4 [FHD]', 'e4'], ['Sky (Main Event)', 'sky main event'],
    ];
    for (const [input, out] of table) expect(normaliseChannelName(input)).toBe(out);
  });
  test('separators', () => {
    expect(isSeparatorName('##### GENERAL FHD #####')).toBe(true);
    expect(isSeparatorName('- - - X')).toBe(true);
    expect(isSeparatorName('BBC 1')).toBe(false);
  });
});

describe('computeLinks', () => {
  test('the ladder prefers id, then name, then normalised', () => {
    const channels = [ch('a.uk', 'Other'), ch('b', 'Alpha'), ch('c', 'BBC One'), ch('Alpha', 'Zzz')];
    const links = run(
      [item(1, 'X', { epgChannelId: 'Alpha' }), item(2, 'Alpha'), item(3, 'UK| BBC 1 HD', { tag: 'UK' })],
      channels,
    );
    expect(links.get(1)).toEqual({ key: 'Alpha', method: 'id' });
    expect(links.get(2)).toEqual({ key: 'Alpha', method: 'id' });
    expect(links.get(3)).toEqual({ key: 'c', method: 'normalised' });
    expect(run([item(4, 'X', { epgChannelId: 'ALPHA ' })], [ch('b', 'alpha ')]).get(4)).toEqual({ key: 'b', method: 'name' });
  });
  test('case-insensitive id and display-name', () => {
    const links = run([item(1, 'X', { epgChannelId: 'bbc1.UK' }), item(2, 'x', { epgChannelId: 'my chan' })], [
      ch('BBC1.uk'), ch('k2', 'My Chan'),
    ]);
    expect(links.get(1)).toEqual({ key: 'BBC1.uk', method: 'id' });
    expect(links.get(2)).toEqual({ key: 'k2', method: 'name' });
  });
  test('display-names carry tags that are stripped', () => {
    const links = run([item(1, 'UK| BBC 1 HD', { tag: 'UK' }), item(2, 'E4')], [
      ch('BBC1.uk', 'UK| BBC 1'), ch('x', '|EN| Foo'), ch('e4', 'E4'), ch('cb', 'KIDS| CBEEBIES HD'),
    ]);
    expect(links.get(1)).toEqual({ key: 'BBC1.uk', method: 'normalised' });
    expect(links.get(2)).toEqual({ key: 'e4', method: 'id' });
    expect(run([item(3, 'KIDS| CBeebies', { tag: 'KIDS' })], [ch('cb', 'KIDS| CBEEBIES HD')]).get(3)?.key).toBe('cb');
    expect(run([item(4, 'Foo')], [ch('x', '|EN| Foo')]).get(4)).toEqual({ key: 'x', method: 'normalised' });
  });
  test('loose colon and dash display-names stay findable as themselves', () => {
    const channels = [ch('sky', 'Sky: Sports'), ch('mtv', 'MTV - Hits')];
    const links = run([item(1, 'Sky: Sports HD'), item(2, 'MTV - Hits FHD')], channels);
    expect(links.get(1)).toEqual({ key: 'sky', method: 'normalised' });
    expect(links.get(2)).toEqual({ key: 'mtv', method: 'normalised' });
  });
  test('ordinary short names are not mangled', () => {
    const names = ['E4', '4Music', '5 STAR', 'W'];
    const channels = names.map((n, i) => ch(`k${i}`, n));
    const links = run(names.map((n, i) => item(i + 1, `${n} HD`)), channels);
    names.forEach((_, i) => expect(links.get(i + 1)).toEqual({ key: `k${i}`, method: 'normalised' }));
  });
  test('an item whose category tag differs from its own falls back to any known tag', () => {
    const links = run([item(1, '|EN| Foo', { tag: null }), item(2, '|EN| Bar', { tag: 'UK' })], [
      ch('foo', '|EN| Foo HD'), ch('bar', 'Bar'),
    ]);
    expect(links.get(1)).toEqual({ key: 'foo', method: 'normalised' });
    expect(links.get(2)).toEqual({ key: 'bar', method: 'normalised' });
  });
  test('bracketed non-Latin text is kept', () => {
    expect(normaliseChannelName('Channel (Ελληνικά)')).toBe('channel ελληνικα');
    expect(normaliseChannelName('Channel [日本]')).toBe('channel 日本');
    expect(normaliseChannelName('Channel (HD)')).toBe('channel');
  });
  test('an exact id match beats a case-insensitive one', () => {
    const links = run([item(1, 'X', { epgChannelId: 'bbc1.uk' })], [ch('BBC1.UK'), ch('bbc1.uk')]);
    expect(links.get(1)).toEqual({ key: 'bbc1.uk', method: 'id' });
  });
  test('ambiguous normalised names prefer the tag country', () => {
    const channels = [ch('BBC1.ie', 'BBC One'), ch('BBC1.uk', 'BBC One')];
    expect(run([item(1, 'UK| BBC 1 HD', { tag: 'UK' })], channels).get(1)?.key).toBe('BBC1.uk');
    expect(run([item(1, 'BBC 1')], channels).get(1)?.key).toBe('BBC1.ie');
  });
  test('ambiguous candidates prefer keys with programmes first', () => {
    const channels = [ch('BBC1.ie', 'BBC One'), ch('BBC1.uk', 'BBC One')];
    const links = run([item(1, 'UK| BBC 1', { tag: 'UK' })], channels, new Map(), { keysWithProgrammes: new Set(['BBC1.ie']) });
    expect(links.get(1)?.key).toBe('BBC1.ie');
  });
  test('a version without an id inherits its sibling guide', () => {
    const links = run(
      [item(1, 'UK| BBC 1 HD', { tag: 'UK', epgChannelId: 'BBC1.uk' }), item(2, 'UK| BBC 1 HEVC', { tag: 'UK' })],
      [ch('BBC1.uk', 'x')],
    );
    expect(links.get(2)).toEqual({ key: 'BBC1.uk', method: 'sibling' });
  });
  test('no regional or prefix inheritance', () => {
    const links = run(
      [item(1, 'BBC 1', { epgChannelId: 'BBC1.uk' }), item(2, 'BBC ONE EAST')],
      [ch('BBC1.uk', 'BBC One')],
    );
    expect(links.has(2)).toBe(false);
  });
  test('manual map wins and a map to a missing key is ignored', () => {
    const channels = [ch('a', 'Alpha'), ch('b', 'Beta')];
    const links = run([item(1, 'Alpha'), item(2, 'Alpha')], channels, new Map([['r1', 'b'], ['r2', 'gone']]));
    expect(links.get(1)).toEqual({ key: 'b', method: 'manual' });
    expect(links.get(2)).toEqual({ key: 'a', method: 'name' });
  });
  test('separator rows are never linked', () => {
    const links = run([item(1, '##### GENERAL FHD #####')], [ch('g', 'General')], new Map([['r1', 'g']]));
    expect(links.size).toBe(0);
  });
});

describe('prepareNames', () => {
  const items = [
    item(1, 'UK| BBC 1 HD', { tag: 'UK', epgChannelId: 'BBC1.uk' }),
    item(2, 'UK| BBC 1 HEVC', { tag: 'UK' }),
    item(3, 'Sky: Sports'),
    item(4, 'US| Fox News', { tag: 'UK' }),
    item(5, '##### GENERAL #####'),
  ];
  const channels = [ch('BBC1.uk', 'UK| BBC One'), ch('sky', 'Sky Sports'), ch('fox', 'Fox News'), ch('g', 'General')];

  test('normalises every name matching looks up, which then links as it would without them', async () => {
    const names = new Map<string, string>();
    await prepareNames(items, channels, names);
    expect(names.get('UK| BBC One')).toBe(normaliseChannelName('UK| BBC One'));
    const prepared = new Map(names);
    const links = run(items, channels, new Map(), { names });
    expect(names).toEqual(prepared); // nothing left to normalise
    expect(links).toEqual(run(items, channels));
  });

  test('yields to the event loop between slices', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => item(i + 1, `Channel ${i + 1}`));
    const names = new Map<string, string>();
    let sizeAtTick = -1;
    setImmediate(() => {
      sizeAtTick = names.size;
    });
    await prepareNames(many, [], names);
    expect(sizeAtTick).toBeGreaterThan(0);
    expect(sizeAtTick).toBeLessThan(names.size);
  });
});

describe('loadMatchItems', () => {
  test('lists each live item once, by id, with the tag of its first category by position', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (1, 'xtream', 'P', '{}', 0)").run();
    const category = db.prepare(
      "INSERT INTO categories (id, provider_id, kind, remote_id, name, position, seen_at, tag) VALUES (?, 1, 'live', ?, ?, ?, 0, ?)",
    );
    category.run(1, 'c1', 'UK| News', 2, 'UK');
    category.run(2, 'c2', 'US| News', 1, 'US');
    category.run(3, 'c3', 'AR| News', 1, 'AR');
    const seed = (id: number, kind: string, epg: string | null, cats: number[]) => {
      db.prepare('INSERT INTO items (id, provider_id, kind, remote_id, name, epg_channel_id, position, seen_at) VALUES (?, 1, ?, ?, ?, ?, ?, 0)')
        .run(id, kind, `r${id}`, `N${id}`, epg, id);
      for (const c of cats) db.prepare('INSERT INTO item_categories (category_id, item_id, position) VALUES (?, ?, 0)').run(c, id);
    };
    seed(4, 'live', 'e4', [1, 2]); // position 1 beats position 2
    seed(2, 'live', null, [1]);
    seed(3, 'live', null, []);
    seed(1, 'live', null, [3, 2]); // equal positions: the smaller category id
    seed(5, 'movie', null, [1]);
    expect(loadMatchItems(db, 1)).toEqual([
      { id: 1, remoteId: 'r1', name: 'N1', epgChannelId: null, tag: 'US' },
      { id: 2, remoteId: 'r2', name: 'N2', epgChannelId: null, tag: 'UK' },
      { id: 3, remoteId: 'r3', name: 'N3', epgChannelId: null, tag: null },
      { id: 4, remoteId: 'r4', name: 'N4', epgChannelId: 'e4', tag: 'US' },
    ]);
    db.close();
  });
});

describe('relinkGuide', () => {
  let db: Db;
  const P = 1;
  const seedItem = (id: number, remote: string, name: string, epg: string | null, cat: number) => {
    db.prepare("INSERT INTO items (id, provider_id, kind, remote_id, name, epg_channel_id, position, seen_at) VALUES (?, ?, 'live', ?, ?, ?, ?, 0)").run(id, P, remote, name, epg, id);
    db.prepare('INSERT INTO item_categories (category_id, item_id, position) VALUES (?, ?, ?)').run(cat, id, id);
  };
  const commit = (source: 'xmltv' | 'provider', channels: { key: string; name: string; names: string[] }[], progKey?: string) => {
    const store = createGuideStore(db);
    const g = store.beginGeneration(P, 1);
    store.insertChannels(P, g, channels);
    if (progKey) store.insertProgrammes(P, g, [{ channelKey: progKey, start: 0, stop: 60, title: 'T', subtitle: null, description: null, category: null }]);
    store.commitGeneration(P, g, { fetchedAt: 1, source });
  };
  const links = () => db.prepare('SELECT item_id AS id, channel_key AS key, method FROM guide_links ORDER BY item_id').all();

  const open = (file = ':memory:') => {
    db = openDb(file);
    db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (1, 'xtream', 'P', '{}', 0)").run();
    db.prepare("INSERT INTO categories (id, provider_id, kind, remote_id, name, position, seen_at, tag) VALUES (1, 1, 'live', 'c1', 'UK| News', 0, 0, 'UK')").run();
    seedItem(1, 'a', 'UK| BBC 1 HD', 'BBC1.uk', 1);
    seedItem(2, 'b', 'UK| BBC 1 HEVC', null, 1);
    seedItem(3, 'c', '##### X #####', null, 1);
  };

  beforeEach(() => open());

  test('writes links and counts methods, idempotently, and cascades deletes', () => {
    commit('xmltv', [{ key: 'BBC1.uk', name: 'x', names: ['Something else'] }], 'BBC1.uk');
    const first = relinkGuide(db, P);
    expect(first).toEqual({ linked: 2, byMethod: { manual: 0, id: 1, name: 0, normalised: 0, sibling: 1, provider: 0 } });
    expect(relinkGuide(db, P)).toEqual(first);
    expect(links()).toEqual([
      { id: 1, key: 'BBC1.uk', method: 'id' }, { id: 2, key: 'BBC1.uk', method: 'sibling' },
    ]);
    db.prepare('DELETE FROM items WHERE id = 2').run();
    expect(links()).toHaveLength(1);
  });

  test('uses manual maps', () => {
    commit('xmltv', [{ key: 'BBC1.uk', name: 'x', names: [] }, { key: 'o', name: 'o', names: [] }]);
    db.prepare("INSERT INTO guide_maps (provider_id, item_remote_id, channel_key) VALUES (1, 'a', 'o')").run();
    relinkGuide(db, P);
    expect(links()[0]).toEqual({ id: 1, key: 'o', method: 'manual' });
  });

  test('provider-source guides link by stream id', () => {
    commit('provider', [{ key: 'stream:b', name: 'B', names: ['B'] }, { key: 'stream:c', name: 'C', names: ['C'] }]);
    expect(relinkGuide(db, P)).toMatchObject({ linked: 1, byMethod: { provider: 1 } });
    expect(links()).toEqual([{ id: 2, key: 'stream:b', method: 'provider' }]); // separator row c stays unlinked
  });

  test('replaces stale links and leaves other providers alone', () => {
    db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (2, 'xtream', 'Q', '{}', 0)").run();
    db.prepare("INSERT INTO items (id, provider_id, kind, remote_id, name, position, seen_at) VALUES (9, 2, 'live', 'z', 'Z', 1, 0)").run();
    db.prepare("INSERT INTO guide_links (item_id, provider_id, channel_key, method) VALUES (9, 2, 'zz', 'id')").run();
    commit('xmltv', [{ key: 'BBC1.uk', name: 'x', names: [] }]);
    relinkGuide(db, P);
    expect(links().map((l) => (l as { id: number }).id)).toEqual([1, 2, 9]);
    db.prepare("UPDATE items SET epg_channel_id = 'gone' WHERE id = 1").run();
    db.prepare("UPDATE items SET name = 'Nothing' WHERE id = 2").run();
    relinkGuide(db, P);
    expect(links()).toEqual([{ id: 9, key: 'zz', method: 'id' }]);
  });

  const generation = () => db.prepare('SELECT generation FROM guide_state WHERE provider_id = ?').pluck().get(P) as number;
  const channels = [{ key: 'BBC1.uk', name: 'x', names: [] }, { key: 'o', name: 'o', names: [] }];

  test('a plan matches as relinkGuide does, and is written as planned when nothing was written since', async () => {
    commit('xmltv', channels, 'BBC1.uk');
    const relinked = relinkGuide(db, P);
    const plan = await planLinks(db, P, generation(), 'xmltv', new Map());
    expect([...plan.links]).toEqual([[1, { key: 'BBC1.uk', method: 'id' }], [2, { key: 'BBC1.uk', method: 'sibling' }]]);
    // Not matched again: a planned link that matching would never make is written as it is.
    plan.links.set(2, { key: 'o', method: 'manual' });
    expect(applyLinks(db, P, plan, new Map())).toEqual({ ...relinked, byMethod: { ...relinked.byMethod, sibling: 0, manual: 1 } });
    expect(links()).toEqual([{ id: 1, key: 'BBC1.uk', method: 'id' }, { id: 2, key: 'o', method: 'manual' }]);
  });

  test('a write since the plan read its inputs makes it match again', async () => {
    commit('xmltv', channels, 'BBC1.uk');
    const plan = await planLinks(db, P, generation(), 'xmltv', new Map());
    expect(plan.links.get(1)).toEqual({ key: 'BBC1.uk', method: 'id' });
    db.prepare("INSERT INTO guide_maps (provider_id, item_remote_id, channel_key) VALUES (1, 'a', 'o')").run();
    applyLinks(db, P, plan, new Map());
    expect(links()[0]).toEqual({ id: 1, key: 'o', method: 'manual' });
  });

  test("another connection's write makes it match again too", async () => {
    db.close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-match-'));
    const file = path.join(dir, 'guide.sqlite');
    open(file);
    const other = openDb(file);
    try {
      commit('xmltv', channels, 'BBC1.uk');
      const plan = await planLinks(db, P, generation(), 'xmltv', new Map());
      other.prepare("INSERT INTO guide_maps (provider_id, item_remote_id, channel_key) VALUES (1, 'a', 'o')").run();
      applyLinks(db, P, plan, new Map());
      expect(links()[0]).toEqual({ id: 1, key: 'o', method: 'manual' });
    } finally {
      other.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
