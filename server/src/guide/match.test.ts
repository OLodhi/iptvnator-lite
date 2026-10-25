import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createGuideStore } from './store.ts';
import {
  applyLinks, computeLinks, isSeparatorName, linkCandidates, loadMatchItems, normaliseChannelName, planLinks, prepareNames,
  relinkGuide, relinkGuideInSteps,
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
  test('a word that names an inherited object member is kept as a word', () => {
    expect(normaliseChannelName('Constructor TV')).toBe('constructor tv');
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

describe('computeLinks past a channel without listings', () => {
  // Listed keys have a programme airing now or upcoming; stale ones only programmes that have ended.
  const guide = (listed: string[], stale: string[] = []) => ({
    keysWithListings: new Set(listed),
    keysWithProgrammes: new Set([...listed, ...stale]),
  });

  test('an id match to a channel with no programmes falls through to a later step that has listings, with its method', () => {
    const channels = [
      ch('Alpha'), ch('a2.uk', 'Alpha'),
      ch('empty2', 'Old'), ch('bravo.uk', 'UK| Bravo'),
      ch('empty3', 'Old C'), ch('charlie.uk', 'C1'),
    ];
    const items = [
      item(1, 'UK| X', { epgChannelId: 'Alpha', tag: 'UK' }), // its guide id is also a2.uk's display-name
      item(2, 'UK| Bravo HD', { epgChannelId: 'empty2', tag: 'UK' }),
      item(3, 'UK| Charlie HD', { epgChannelId: 'empty3', tag: 'UK' }),
      item(4, 'UK| Charlie HD ◉', { epgChannelId: 'charlie.uk', tag: 'UK' }),
    ];
    const links = run(items, channels, new Map(), guide(['a2.uk', 'bravo.uk', 'charlie.uk']));
    expect(links.get(1)).toEqual({ key: 'a2.uk', method: 'name' });
    expect(links.get(2)).toEqual({ key: 'bravo.uk', method: 'normalised' });
    expect(links.get(3)).toEqual({ key: 'charlie.uk', method: 'sibling' });
    expect(links.get(4)).toEqual({ key: 'charlie.uk', method: 'id' });
  });

  test('an id match to a stale stub falls through the same way', () => {
    const channels = [ch('TNT.Sports.1.HD.uk', 'UK| TNT SPORTS 1 HD'), ch('TNTSports1.uk', 'UK| TNT Sports 1')];
    const items = [item(1, 'UK| TNT SPORTS 1 HD', { epgChannelId: 'TNT.Sports.1.HD.uk', tag: 'UK' })];
    const links = run(items, channels, new Map(), guide(['TNTSports1.uk'], ['TNT.Sports.1.HD.uk']));
    expect(links.get(1)).toEqual({ key: 'TNTSports1.uk', method: 'normalised' });
  });

  test('an id match with listings stays, whatever later steps would find', () => {
    const channels = [ch('bbc1.uk', 'BBC1.uk'), ch('bbc.alt', 'BBC One'), ch('BBC1.UK')];
    const items = [item(1, 'UK| BBC 1', { epgChannelId: 'bbc1.uk', tag: 'UK' })];
    const links = run(items, channels, new Map(), guide(['bbc1.uk', 'bbc.alt', 'BBC1.UK']));
    expect(links.get(1)).toEqual({ key: 'bbc1.uk', method: 'id' });
  });

  test('with no later key that has listings, the first match stays as it was', () => {
    const channels = [ch('empty', 'Nope'), ch('stale.uk', 'UK| Delta'), ch('also.empty', 'Delta'), ch('n', 'Echo')];
    const items = [
      item(1, 'UK| Delta HD', { epgChannelId: 'empty', tag: 'UK' }),
      item(2, 'Echo HD'),
      item(3, 'UK| Delta FHD', { tag: 'UK' }),
    ];
    const withGuide = run(items, channels, new Map(), guide([], ['stale.uk']));
    expect(withGuide.get(1)).toEqual({ key: 'empty', method: 'id' });
    expect(withGuide.get(2)).toEqual({ key: 'n', method: 'normalised' });
    expect(withGuide.get(3)).toEqual({ key: 'stale.uk', method: 'normalised' });
    expect(withGuide).toEqual(run(items, channels, new Map(), { keysWithProgrammes: new Set(['stale.uk']) }));
  });

  test('an id match to a case variant with listings is still an id match', () => {
    const items = [item(1, 'UK| X', { epgChannelId: 'bbc1.uk', tag: 'UK' })];
    const links = run(items, [ch('bbc1.uk'), ch('BBC1.UK')], new Map(), guide(['BBC1.UK']));
    expect(links.get(1)).toEqual({ key: 'BBC1.UK', method: 'id' });
  });

  test('a manual map to an empty channel is never overridden', () => {
    const channels = [ch('empty', 'Nothing'), ch('full.uk', 'UK| Foxtrot')];
    const items = [item(1, 'UK| Foxtrot', { epgChannelId: 'full.uk', tag: 'UK' }), item(2, 'UK| Foxtrot HD', { tag: 'UK' })];
    const links = run(items, channels, new Map([['r1', 'empty']]), guide(['full.uk']));
    expect(links.get(1)).toEqual({ key: 'empty', method: 'manual' });
    expect(links.get(2)).toEqual({ key: 'full.uk', method: 'normalised' });
  });

  test('ambiguous candidates prefer keys with listings, then keys with programmes', () => {
    const channels = [ch('a.uk', 'Golf'), ch('b.uk', 'Golf'), ch('c.uk', 'Golf')];
    const items = [item(1, 'UK| Golf', { tag: 'UK' })];
    expect(run(items, channels, new Map(), guide(['c.uk'], ['a.uk', 'b.uk'])).get(1)?.key).toBe('c.uk');
    expect(run(items, channels, new Map(), guide([], ['b.uk'])).get(1)?.key).toBe('b.uk');
  });

  test('sibling inheritance gives X HD the key of X HD ◉ when its own id key is empty', () => {
    const channels = [ch('TNT.Sports.1.HD.uk', 'Old TNT'), ch('TNTSports1.uk', 'TNT S1'), ch('other', 'Other')];
    const items = [
      item(1, 'UK| TNT SPORTS 1 HD', { epgChannelId: 'TNT.Sports.1.HD.uk', tag: 'UK' }),
      item(2, 'UK| TNT SPORTS 1 HD ◉', { epgChannelId: 'TNTSports1.uk', tag: 'UK' }),
      item(3, 'UK| TNT SPORTS 1 FHD', { tag: 'UK' }), // no match of its own: inherits, preferring listings
      item(4, 'UK| Other HD', { epgChannelId: 'other', tag: 'UK' }), // no sibling has listings: stays
    ];
    const links = run(items, channels, new Map(), guide(['TNTSports1.uk']));
    expect(links.get(1)).toEqual({ key: 'TNTSports1.uk', method: 'sibling' });
    expect(links.get(2)).toEqual({ key: 'TNTSports1.uk', method: 'id' });
    expect(links.get(3)).toEqual({ key: 'TNTSports1.uk', method: 'sibling' });
    expect(links.get(4)).toEqual({ key: 'other', method: 'id' });
    // Without listings, siblings inherit as before: the smallest key.
    expect(run(items, channels).get(3)).toEqual({ key: 'TNT.Sports.1.HD.uk', method: 'sibling' });
  });
});

describe('the fall-through stays in the item own country (P3-R32)', () => {
  const guide = (listed: string[]) => ({ keysWithListings: new Set(listed), keysWithProgrammes: new Set(listed) });

  test('a foreign channel with listings never replaces an empty id (the real cases)', () => {
    // Item, its own guide id (an empty channel), the foreign channel with listings matching found, its display-name.
    const cases: [string, string, string, string][] = [
      ['UK| SKY CINEMA PREMIERE HD', 'SkyCinemaPremiere.uk', 'SkyCinemaPremiere.de', 'WOW| SKY CINEMA PREMIERE ᴴᴰ ◉'],
      ['UK| EUROSPORT 1 HD', 'uk.Eurosport 1', 'Eurosport', 'PL| EUROSPORT 1 FHD'],
      ['UK| EUROSPORT 2 HD', 'uk.Eurosport 2', 'Eurosport2.cz', 'CZ| EUROSPORT 2 HD'],
      ['UK| TRAVEL CHANNEL', 'TravelChannel.uk', 'TVPaprika.hu', 'HU| TRAVEL CHANNEL'],
      ['UK| MTV CLASSIC', 'MTVClassic.uk', 'MTVClassic.us', 'US| MTV CLASSIC'],
      ['UK| DISNEY CHANNEL FHD', 'DisneyChannel.uk', 'DisneyChannel.ca', 'CA| DISNEY CHANNEL HD'],
      ['UK| BEIN SPORTS 1 HD', 'beINSports5En.qa', 'BeinSports1.fr', 'FR| BEIN SPORTS 1 4K'],
    ];
    const items = cases.map(([name, id], i) => item(i + 1, name, { epgChannelId: id, tag: 'UK' }));
    const channels = cases.flatMap(([name, id, foreign, display]) => [ch(id, name), ch(foreign, display)]);
    const links = run(items, channels, new Map(), guide(cases.map((c) => c[2])));
    cases.forEach(([, id], i) => expect(links.get(i + 1)).toEqual({ key: id, method: 'id' }));
  });

  test("nor does a foreign sibling's key", () => {
    const items = [
      item(1, 'UK| EUROSPORT 1 HD', { epgChannelId: 'uk.Eurosport 1', tag: 'UK' }),
      item(2, 'PL| EUROSPORT 1 FHD', { epgChannelId: 'Eurosport', tag: 'PL' }),
    ];
    const links = run(items, [ch('uk.Eurosport 1', 'Old'), ch('Eurosport', 'Eurosport PL')], new Map(), guide(['Eurosport']));
    expect(links.get(1)).toEqual({ key: 'uk.Eurosport 1', method: 'id' });
    expect(links.get(2)).toEqual({ key: 'Eurosport', method: 'id' });
  });

  test('a candidate of its own country still takes over: by key suffix, display-name, or sibling (the real cases)', () => {
    const items = [
      item(1, 'UK| LFC TV', { epgChannelId: 'uk.425 LFCTV HD', tag: 'UK' }),
      item(2, 'UK| CRIME INVESTIGATION HEVC HD', { epgChannelId: 'CrimeInvestigation.uk', tag: 'UK' }),
      item(3, 'UK| PREMIER SPORTS 2 FHD', { epgChannelId: 'ViaplaySports2.uk', tag: 'UK' }),
      item(4, 'UK| PREMIER SPORTS 2 HD', { epgChannelId: 'PremierSports2', tag: 'UK' }),
    ];
    const channels = [
      ch('uk.425 LFCTV HD', 'Old LFC'), ch('LiverpoolFCTV.uk', 'SPT| LFC TV FHD'), // the key's suffix
      ch('CrimeInvestigation.uk', 'Old CI'), ch('CrimeAndInvestigationNetwork.uk', 'UK| CRIME INVESTIGATION FHD'),
      ch('ViaplaySports2.uk', 'Old PS2'), ch('PremierSports2', 'UK-NOWTV| PREMIER SPORTS 2 FHD'), // a sub-tagged name
    ];
    const links = run(items, channels, new Map(), guide(['LiverpoolFCTV.uk', 'CrimeAndInvestigationNetwork.uk', 'PremierSports2']));
    expect(links.get(1)).toEqual({ key: 'LiverpoolFCTV.uk', method: 'normalised' });
    expect(links.get(2)).toEqual({ key: 'CrimeAndInvestigationNetwork.uk', method: 'normalised' });
    expect(links.get(3)).toEqual({ key: 'PremierSports2', method: 'sibling' });
  });

  test("a display-name leads with the item's tag as a whole token, in any known pattern", () => {
    const linkFor = (display: string) =>
      run(
        [item(1, 'UK| Kilo HD', { epgChannelId: 'kilo.empty', tag: 'UK' }), item(2, 'UK| Kilo FHD', { epgChannelId: 'k', tag: 'UK' })],
        [ch('kilo.empty', 'Old'), ch('k', display)],
        new Map(),
        guide(['k']),
      ).get(1)?.key;
    for (const own of ['UK| Kilo', '|UK| Kilo', '[UK] Kilo', 'UK: Kilo', 'UK - Kilo', 'UK-NOWTV| Kilo', 'uk| Kilo']) {
      expect(linkFor(own), own).toBe('k');
    }
    for (const foreign of ['UKTV| Kilo', 'WOW| Kilo', 'PL| Kilo', 'SPT| Kilo', 'Kilo UK', 'Kilo']) {
      expect(linkFor(foreign), foreign).toBe('kilo.empty');
    }
  });

  test('an item without a tag never falls through', () => {
    const items = [item(1, 'LFC TV', { epgChannelId: 'uk.425 LFCTV HD' })];
    const links = run(items, [ch('uk.425 LFCTV HD', 'Old LFC'), ch('LiverpoolFCTV.uk', 'UK| LFC TV FHD')], new Map(), guide(['LiverpoolFCTV.uk']));
    expect(links.get(1)).toEqual({ key: 'uk.425 LFCTV HD', method: 'id' });
  });

  test('without an id hit, the ladder is not restricted', () => {
    const channels = [ch('MTVClassic.us', 'US| MTV CLASSIC')];
    const items = [item(1, 'UK| MTV CLASSIC', { epgChannelId: 'gone.uk', tag: 'UK' }), item(2, 'MTV CLASSIC HD')];
    const links = run(items, channels, new Map(), guide(['MTVClassic.us']));
    expect(links.get(1)).toEqual({ key: 'MTVClassic.us', method: 'normalised' });
    expect(links.get(2)).toEqual({ key: 'MTVClassic.us', method: 'normalised' });
  });
});

describe('linkCandidates', () => {
  test("lists each item's possible first matches, and later candidates of its own country only; siblings share", () => {
    const channels = [
      ch('alpha.uk', 'UK| Alpha'), ch('ALPHA.UK', 'Old'), ch('alpha.de', 'DE| Alpha'), ch('alpha.x', '[UK] Alpha'),
      ch('bravo.de', 'DE| Bravo'), ch('bravo.uk', 'Bravo'),
      ch('charlie.uk', 'Old C'), ch('charlie2.uk', 'Charlie'),
      ch('m', 'Mike'),
    ];
    const items = [
      item(1, 'UK| Alpha', { epgChannelId: 'alpha.uk', tag: 'UK' }),
      item(2, 'UK| Bravo HD', { tag: 'UK' }),
      item(3, 'Charlie', { epgChannelId: 'charlie.uk' }),
      item(4, 'UK| Alpha HEVC', { tag: 'UK' }),
      item(5, '##### X #####'),
      item(6, 'Nothing'),
    ];
    const c = linkCandidates({ items, channels, manual: new Map([['r4', 'm']]) });
    // Its id, then (falling through) the UK case variant and the UK-named channel, and a sibling's map; not alpha.de.
    expect([...c.get(1)!].sort()).toEqual(['ALPHA.UK', 'alpha.uk', 'alpha.x', 'm']);
    // Its first step is the normalised one, any of whose keys may be its first match.
    expect([...c.get(2)!].sort()).toEqual(['bravo.de', 'bravo.uk']);
    // No tag: it never falls through, so its later candidates are not wanted.
    expect([...c.get(3)!]).toEqual(['charlie.uk']);
    expect([...c.get(4)!]).toEqual(['m']);
    expect(c.has(5)).toBe(false);
    expect([...(c.get(6) ?? [])]).toEqual([]);
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
  // A fixed "now", long ago, so the real clock never decides which channels have listings.
  const T = 1_000_000;
  // BBC1.uk (item 1's guide id) has one programme, which ended an hour before T; live.uk's is on at T.
  const stubAndLive = () => {
    const store = createGuideStore(db);
    const g = store.beginGeneration(P, 1);
    store.insertChannels(P, g, [{ key: 'BBC1.uk', name: 'x', names: ['x'] }, { key: 'live.uk', name: 'BBC One', names: ['BBC One'] }]);
    const row = (channelKey: string, start: number, stop: number) => ({
      channelKey, start, stop, title: 'T', subtitle: null, description: null, category: null,
    });
    store.insertProgrammes(P, g, [row('BBC1.uk', T - 7200, T - 3600), row('live.uk', T - 600, T + 3000)]);
    store.commitGeneration(P, g, { fetchedAt: 1, source: 'xmltv' });
  };
  const toLive = [{ id: 1, key: 'live.uk', method: 'normalised' }, { id: 2, key: 'live.uk', method: 'normalised' }];

  test('an id match whose only programme has stopped falls through to a key with listings at that time', () => {
    stubAndLive();
    relinkGuide(db, P, T);
    expect(links()).toEqual(toLive);
    // Until it stops, the stub's programme is on: the id match stands.
    relinkGuide(db, P, T - 3601);
    expect(links()[0]).toEqual({ id: 1, key: 'BBC1.uk', method: 'id' });
    relinkGuide(db, P, T - 3600);
    expect(links()[0]).toEqual({ id: 1, key: 'live.uk', method: 'normalised' });
  });

  test("listings are found from each channel's own programmes, never by reading the whole guide's", () => {
    // 50 channels of 200 programmes from T, and 2,000 channels with none: read through the guide's stop index, each
    // empty channel costs a pass over all 10,000 programmes (seconds in all), against a probe of its own.
    const store = createGuideStore(db);
    const g = store.beginGeneration(P, 1);
    const full = Array.from({ length: 50 }, (_, c) => `full${c}`);
    const empty = Array.from({ length: 2000 }, (_, c) => `empty${c}`);
    store.insertChannels(P, g, [...full, ...empty].map((key) => ({ key, name: key, names: [key] })));
    store.insertProgrammes(P, g, full.flatMap((channelKey) => Array.from({ length: 200 }, (_, i) => ({
      channelKey, start: T + i * 60, stop: T + i * 60 + 60, title: 'T', subtitle: null, description: null, category: null,
    }))));
    store.commitGeneration(P, g, { fetchedAt: 1, source: 'xmltv' });
    db.prepare("UPDATE items SET epg_channel_id = 'full0' WHERE id = 1").run();
    const t0 = performance.now();
    relinkGuide(db, P, T);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(links()[0]).toEqual({ id: 1, key: 'full0', method: 'id' });
  });

  test('given no time, the relinks read the clock', async () => {
    stubAndLive();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(T * 1000);
      relinkGuide(db, P);
      expect(links()).toEqual(toLive);
      db.prepare('DELETE FROM guide_links').run();
      await relinkGuideInSteps(db, P);
      expect(links()).toEqual(toLive);
      vi.setSystemTime((T - 3601) * 1000);
      relinkGuide(db, P);
      expect(links()[0]).toEqual({ id: 1, key: 'BBC1.uk', method: 'id' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a plan that must match again judges listings at its own time', async () => {
    stubAndLive();
    const plan = await planLinks(db, P, generation(), 'xmltv', new Map(), T);
    expect(plan.links.get(1)).toEqual({ key: 'live.uk', method: 'normalised' });
    db.prepare("INSERT INTO guide_maps (provider_id, item_remote_id, channel_key) VALUES (1, 'b', 'BBC1.uk')").run();
    applyLinks(db, P, plan, new Map());
    expect(links()).toEqual([{ id: 1, key: 'live.uk', method: 'normalised' }, { id: 2, key: 'BBC1.uk', method: 'manual' }]);
  });

  test('relinkGuideInSteps judges a generation committed while it matched at its own time', async () => {
    commit('xmltv', channels, 'BBC1.uk');
    const pending = relinkGuideInSteps(db, P, T);
    stubAndLive();
    await pending;
    expect(links()).toEqual(toLive);
  });

  test('a plan matches as relinkGuide does, and is written as planned when nothing was written since', async () => {
    commit('xmltv', channels, 'BBC1.uk');
    const relinked = relinkGuide(db, P);
    const plan = await planLinks(db, P, generation(), 'xmltv', new Map(), T);
    expect([...plan.links]).toEqual([[1, { key: 'BBC1.uk', method: 'id' }], [2, { key: 'BBC1.uk', method: 'sibling' }]]);
    // Not matched again: a planned link that matching would never make is written as it is.
    plan.links.set(2, { key: 'o', method: 'manual' });
    expect(applyLinks(db, P, plan, new Map())).toEqual({ ...relinked, byMethod: { ...relinked.byMethod, sibling: 0, manual: 1 } });
    expect(links()).toEqual([{ id: 1, key: 'BBC1.uk', method: 'id' }, { id: 2, key: 'o', method: 'manual' }]);
  });

  test('a write since the plan read its inputs makes it match again', async () => {
    commit('xmltv', channels, 'BBC1.uk');
    const plan = await planLinks(db, P, generation(), 'xmltv', new Map(), T);
    expect(plan.links.get(1)).toEqual({ key: 'BBC1.uk', method: 'id' });
    db.prepare("INSERT INTO guide_maps (provider_id, item_remote_id, channel_key) VALUES (1, 'a', 'o')").run();
    applyLinks(db, P, plan, new Map());
    expect(links()[0]).toEqual({ id: 1, key: 'o', method: 'manual' });
  });

  test('relinkGuideInSteps links as relinkGuide does, yielding before it writes', async () => {
    commit('xmltv', channels, 'BBC1.uk');
    const expected = relinkGuide(db, P);
    const relinked = links();
    db.prepare('DELETE FROM guide_links').run();
    let linksAtTick = -1;
    setImmediate(() => {
      linksAtTick = links().length;
    });
    expect(await relinkGuideInSteps(db, P)).toEqual(expected);
    expect(linksAtTick).toBe(0);
    expect(links()).toEqual(relinked);
  });

  test('relinkGuideInSteps links a generation committed while it matched', async () => {
    commit('xmltv', channels, 'BBC1.uk');
    const pending = relinkGuideInSteps(db, P);
    commit('xmltv', [{ key: 'bbc', name: 'BBC One', names: ['BBC One'] }]); // not pruned, so the old one stays readable
    await pending;
    expect(links()).toEqual([{ id: 1, key: 'bbc', method: 'normalised' }, { id: 2, key: 'bbc', method: 'normalised' }]);
  });

  test("another connection's write makes it match again too", async () => {
    db.close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-match-'));
    const file = path.join(dir, 'guide.sqlite');
    open(file);
    const other = openDb(file);
    try {
      commit('xmltv', channels, 'BBC1.uk');
      const plan = await planLinks(db, P, generation(), 'xmltv', new Map(), T);
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
