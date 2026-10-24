import { beforeEach, describe, expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { createGuideStore, TEXT_LIMITS } from './store.ts';
import type { GuideStore, ProgrammeRow } from './store.ts';

let db: Db;
let store: GuideStore;
const P = 1;

const prog = (channelKey: string, start: number, extra: Partial<ProgrammeRow> = {}): ProgrammeRow => ({
  channelKey, start, stop: start + 60, title: 'T', subtitle: null, description: null, category: null, ...extra,
});
const count = (table: string, generation?: number): number =>
  (db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE provider_id = ?${generation === undefined ? '' : ' AND generation = ' + generation}`)
    .get(P) as { n: number }).n;
const commit = (generation: number) => store.commitGeneration(P, generation, { fetchedAt: 500, source: 'xmltv' });

beforeEach(() => {
  db = openDb(':memory:');
  store = createGuideStore(db);
  db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (1, 'xtream', 'P', '{}', 0)").run();
});

describe('guide store', () => {
  test('a new generation is invisible until committed', () => {
    expect(store.state(P)).toBeNull();
    expect(store.currentGeneration(P)).toBe(0);
    const g = store.beginGeneration(P, 100);
    expect(g).toBe(1);
    store.insertChannels(P, g, [{ key: 'bbc1', name: 'BBC 1', names: ['BBC 1', 'BBC One'] }]);
    store.insertProgrammes(P, g, [prog('bbc1', 0)]);
    expect(store.currentGeneration(P)).toBe(0);
    expect(store.state(P)?.attemptedAt).toBe(100);
    commit(g);
    expect(store.currentGeneration(P)).toBe(1);
    expect(store.state(P)).toMatchObject({ generation: 1, fetchedAt: 500, source: 'xmltv', failures: 0, lastError: null });
    expect(db.prepare('SELECT names FROM guide_channels').get()).toEqual({ names: '["BBC 1","BBC One"]' });
  });

  test('insertProgrammes ignores duplicates and truncates text', () => {
    const g = store.beginGeneration(P, 1);
    const n = store.insertProgrammes(P, g, [prog('a', 0), prog('a', 0, { title: 'Dup' })]);
    expect(n).toBe(1);
    store.insertProgrammes(P, g, [
      prog('a', 100, {
        title: 'x'.repeat(1000), subtitle: 'y'.repeat(1000), description: 'd'.repeat(5000), category: 'c'.repeat(500),
      }),
    ]);
    const row = db.prepare('SELECT title, subtitle, description, category FROM programmes WHERE start = 100').get() as Record<string, string>;
    expect(row.title).toHaveLength(TEXT_LIMITS.title);
    expect(row.subtitle).toHaveLength(TEXT_LIMITS.subtitle);
    expect(row.description).toHaveLength(1000);
    expect(row.category).toHaveLength(TEXT_LIMITS.category);
  });

  test('abandon removes only that generation', async () => {
    const g1 = store.beginGeneration(P, 1);
    store.insertChannels(P, g1, [{ key: 'a', name: 'A', names: [] }]);
    store.insertProgrammes(P, g1, [prog('a', 0)]);
    commit(g1);
    const g2 = store.beginGeneration(P, 2);
    store.insertChannels(P, g2, [{ key: 'a', name: 'A', names: [] }]);
    store.insertProgrammes(P, g2, [prog('a', 0), prog('a', 60)]);
    await store.abandonGeneration(P, g2);
    expect(count('programmes', 1)).toBe(1);
    expect(count('programmes', 2)).toBe(0);
    expect(count('guide_channels', 1)).toBe(1);
    expect(count('guide_channels', 2)).toBe(0);
    expect(store.currentGeneration(P)).toBe(1);
  });

  test('prune keeps the current generation only', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => prog('a', i * 60));
    const g1 = store.beginGeneration(P, 1);
    store.insertChannels(P, g1, [{ key: 'a', name: 'A', names: [] }]);
    store.insertProgrammes(P, g1, rows);
    commit(g1);
    const g2 = store.beginGeneration(P, 2);
    store.insertProgrammes(P, g2, rows.slice(0, 5));
    commit(g2);
    const removed = await store.pruneGenerations(P);
    expect(removed).toBe(2500 + 1);
    expect(count('programmes', 1)).toBe(0);
    expect(count('programmes', 2)).toBe(5);
    expect(count('guide_channels')).toBe(0);
  });

  test('recordFailure counts and commit resets', () => {
    store.recordFailure(P, 'boom');
    store.recordFailure(P, 'bang');
    expect(store.state(P)).toMatchObject({ generation: 0, failures: 2, lastError: 'bang' });
    commit(store.beginGeneration(P, 1));
    expect(store.state(P)).toMatchObject({ generation: 1, failures: 0, lastError: null });
  });

  test('deleting the provider cascades', () => {
    const g = store.beginGeneration(P, 1);
    store.insertChannels(P, g, [{ key: 'a', name: 'A', names: [] }]);
    store.insertProgrammes(P, g, [prog('a', 0)]);
    commit(g);
    db.prepare('DELETE FROM providers WHERE id = 1').run();
    for (const table of ['guide_state', 'guide_channels', 'programmes']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});
