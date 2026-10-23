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
export type Category = { id: number; name: string; itemCount: number };
export type CatalogItem = {
  id: number;
  providerId: number;
  kind: Kind;
  name: string;
  logoUrl: string | null;
  catchupDays: number | null;
  year: number | null;
  rating: string | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Episode = { remoteId: string; title: string; episodeNum: number; durationSec: number | null };
export type Season = { season: number; episodes: Episode[] };
/** `url` is server-relative: `/api/sessions/<id>/index.m3u8` (HLS) or `/api/sessions/<id>/direct`. */
export type PlayResponse = {
  sessionId: string;
  mode: 'hls' | 'direct';
  url: string;
  durationSec: number | null;
  startAtSec: number;
};
