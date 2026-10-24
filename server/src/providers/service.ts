import type { AddProviderRequest, ProviderSummary } from '@tv/shared';
import type { Db } from '../db/db.ts';
import { createProviderRepo } from './repo.ts';
import type { ProviderRow } from './repo.ts';
import { createXtreamClient } from './xtream/client.ts';
import type { XtreamAccount, XtreamClient } from './xtream/client.ts';
import { normaliseServerUrl } from './xtream/normalise.ts';

export interface ProviderService {
  add(req: AddProviderRequest): Promise<ProviderSummary>;
  list(): ProviderSummary[];
  get(id: number): ProviderSummary | undefined;
  clientFor(id: number): XtreamClient;
  account(id: number): XtreamAccount | null;
  markSynced(id: number, at: number): void;
  /** Re-reads the account from the provider and stores it. */
  refreshAccount(id: number): Promise<XtreamAccount>;
}

export function createProviderService(deps: {
  db: Db;
  userAgent: string;
  makeClient?: typeof createXtreamClient;
  onAdded?: (id: number) => void;
}): ProviderService {
  const repo = createProviderRepo(deps.db);
  const makeClient = deps.makeClient ?? createXtreamClient;

  const summary = (r: ProviderRow): ProviderSummary => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    maxConnections: r.account?.maxConnections ?? null,
    lastSyncedAt: r.lastSyncedAt,
  });

  const require = (id: number): ProviderRow => {
    const row = repo.get(id);
    if (!row) throw new Error(`Provider ${id} not found`);
    return row;
  };

  return {
    async add(req) {
      const serverUrl = normaliseServerUrl(req.serverUrl);
      const config = { serverUrl, username: req.username, password: req.password };
      const account = await makeClient(config, { userAgent: deps.userAgent }).authenticate();
      const name = req.name?.trim() || new URL(serverUrl).hostname;
      const id = repo.insert({ name, config, account, createdAt: Date.now() });
      deps.onAdded?.(id);
      return summary(require(id));
    },
    list: () => repo.list().map(summary),
    get: (id) => {
      const row = repo.get(id);
      return row ? summary(row) : undefined;
    },
    clientFor: (id) => makeClient(require(id).config, { userAgent: deps.userAgent }),
    account: (id) => require(id).account,
    markSynced: (id, at) => repo.markSynced(id, at),
    async refreshAccount(id) {
      const account = await makeClient(require(id).config, { userAgent: deps.userAgent }).authenticate();
      repo.updateAccount(id, account);
      return account;
    },
  };
}
