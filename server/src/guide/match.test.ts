import { beforeEach, describe, expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createGuideStore } from './store.ts';
import { computeLinks, isSeparatorName, normaliseChannelName, relinkGuide } from './match.ts';
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

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (1, 'xtream', 'P', '{}', 0)").run();
    db.prepare("INSERT INTO categories (id, provider_id, kind, remote_id, name, position, seen_at, tag) VALUES (1, 1, 'live', 'c1', 'UK| News', 0, 0, 'UK')").run();
    seedItem(1, 'a', 'UK| BBC 1 HD', 'BBC1.uk', 1);
    seedItem(2, 'b', 'UK| BBC 1 HEVC', null, 1);
    seedItem(3, 'c', '##### X #####', null, 1);
  });

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
    commit('provider', [{ key: 'stream:b', name: 'B', names: ['B'] }]);
    expect(relinkGuide(db, P)).toMatchObject({ linked: 1, byMethod: { provider: 1 } });
    expect(links()).toEqual([{ id: 2, key: 'stream:b', method: 'provider' }]);
  });
});
