import { expect, test } from 'vitest';
import { openDb } from '../db/db.ts';
import { createCurationService } from '../curation/service.ts';
import { DEFAULT_USER_ID } from '../users.ts';
import { visibleLiveItemIds } from './visible.ts';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO providers (id, kind, name, config, created_at) VALUES (1, 'xtream', 'p', '{}', 0)").run();
  return db;
}

test('lists visible live items by category then item position, once each', () => {
  const db = setup();
  const cat = db.prepare("INSERT INTO categories (id, provider_id, kind, remote_id, name, position, seen_at, first_seen_at) VALUES (?, 1, 'live', ?, ?, ?, 1, 1)");
  cat.run(10, 'a', 'A', 2);
  cat.run(11, 'b', 'B', 1);
  const item = db.prepare("INSERT INTO items (id, provider_id, kind, remote_id, name, position, seen_at) VALUES (?, 1, 'live', ?, ?, ?, 1)");
  for (const id of [1, 2, 3]) item.run(id, String(id), `ch${id}`, id);
  const link = db.prepare('INSERT INTO item_categories (category_id, item_id, position, seen_at) VALUES (?, ?, ?, 1)');
  link.run(11, 3, 0);
  link.run(11, 1, 1);
  link.run(10, 1, 0); // also in the later category: listed once, at its first place
  link.run(10, 2, 1);
  const curation = createCurationService({ db, now: Date.now });
  expect(visibleLiveItemIds(db, curation, 1, DEFAULT_USER_ID)).toEqual([3, 1, 2]);
  expect(visibleLiveItemIds(db, curation, 99, DEFAULT_USER_ID)).toEqual([]);
});
