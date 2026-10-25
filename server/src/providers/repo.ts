import type { Db } from '../db/db.ts';
import type { XtreamAccount, XtreamCreds } from './xtream/client.ts';

export type ProviderRow = {
  id: number;
  kind: 'xtream';
  name: string;
  config: XtreamCreds;
  account: XtreamAccount | null;
  createdAt: number;
  lastSyncedAt: number | null;
};

type RawRow = {
  id: number;
  kind: 'xtream';
  name: string;
  config: string;
  account: string | null;
  created_at: number;
  last_synced_at: number | null;
};

// Accounts stored before the timezone field existed lack the key.
const withTimezone = (a: XtreamAccount): XtreamAccount => ({ ...a, timezone: a.timezone ?? null });

function toRow(r: RawRow): ProviderRow {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    config: JSON.parse(r.config) as XtreamCreds,
    account: r.account ? withTimezone(JSON.parse(r.account) as XtreamAccount) : null,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
  };
}

export interface ProviderRepo {
  insert(p: { name: string; config: XtreamCreds; account: XtreamAccount; createdAt: number }): number;
  list(): ProviderRow[];
  get(id: number): ProviderRow | undefined;
  markSynced(id: number, at: number): void;
  updateAccount(id: number, account: XtreamAccount): void;
  /** Providers whose stored account lacks the timezone key; one that stores null (the provider sent none) is not listed. */
  withoutTimezone(): number[];
}

export function createProviderRepo(db: Db): ProviderRepo {
  return {
    insert(p) {
      const info = db
        .prepare(`INSERT INTO providers (kind, name, config, account, created_at) VALUES ('xtream', ?, ?, ?, ?)`)
        .run(p.name, JSON.stringify(p.config), JSON.stringify(p.account), p.createdAt);
      return Number(info.lastInsertRowid);
    },
    list() {
      return (db.prepare('SELECT * FROM providers ORDER BY id').all() as RawRow[]).map(toRow);
    },
    get(id) {
      const r = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as RawRow | undefined;
      return r ? toRow(r) : undefined;
    },
    markSynced(id, at) {
      db.prepare('UPDATE providers SET last_synced_at = ? WHERE id = ?').run(at, id);
    },
    updateAccount(id, account) {
      db.prepare('UPDATE providers SET account = ? WHERE id = ?').run(JSON.stringify(account), id);
    },
    withoutTimezone() {
      // json_type is NULL for a missing key and 'null' for a stored null.
      return db
        .prepare(`SELECT id FROM providers WHERE account IS NOT NULL AND json_type(account, '$.timezone') IS NULL ORDER BY id`)
        .pluck()
        .all() as number[];
    },
  };
}
