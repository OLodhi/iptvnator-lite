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

function toRow(r: RawRow): ProviderRow {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    config: JSON.parse(r.config) as XtreamCreds,
    account: r.account ? (JSON.parse(r.account) as XtreamAccount) : null,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
  };
}

export interface ProviderRepo {
  insert(p: { name: string; config: XtreamCreds; account: XtreamAccount; createdAt: number }): number;
  list(): ProviderRow[];
  get(id: number): ProviderRow | undefined;
  markSynced(id: number, at: number): void;
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
  };
}
