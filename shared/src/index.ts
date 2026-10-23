export type ApiError = { code: string; message: string };
export type Kind = 'live' | 'movie' | 'series';
export type ProviderSummary = {
  id: number;
  name: string;
  kind: 'xtream';
  maxConnections: number | null;
  lastSyncedAt: number | null;
};
export type SyncCounts = { categories: number; items: number; removed: number };
export type SyncResult = Record<Kind, SyncCounts>;
export type SyncStatus = {
  state: 'idle' | 'running' | 'failed';
  startedAt: number | null;
  finishedAt: number | null;
  result: SyncResult | null;
  error: string | null;
};
export type AddProviderRequest = {
  kind: 'xtream';
  name?: string;
  serverUrl: string;
  username: string;
  password: string;
};
