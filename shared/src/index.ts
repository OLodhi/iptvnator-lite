export type ApiError = { code: string; message: string };
export type Kind = 'live' | 'movie' | 'series';
export type ProviderSummary = {
  id: number;
  name: string;
  kind: 'xtream';
  maxConnections: number | null;
  lastSyncedAt: number | null;
};
export type SyncCounts = { categories: number; items: number; removed: number; skippedPrune: boolean };
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
export type TagStyle = 'tagged' | 'mixed' | 'untagged';
export type CurationCategory = {
  id: number;
  remoteId: string;
  name: string;
  displayName: string;
  itemCount: number;
  visible: boolean;
  isNew: boolean;
};
export type CurationGroup = { tag: string; friendlyName: string | null; hint: string[]; categories: CurationCategory[] };
export type CurationView = {
  kind: Kind;
  style: TagStyle;
  groups: CurationGroup[];
  untagged: CurationCategory[];
  newCount: number;
};
/** Group switches keyed by tag, and single-category choices keyed by the category's `remoteId`. */
export type CurationUpdate = { tags: Record<string, boolean>; categories: Record<string, boolean> };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Episode = { remoteId: string; title: string; episodeNum: number; durationSec: number | null };
export type Season = { season: number; episodes: Episode[] };
export type PlayRequest = { itemId: number; episodeRemoteId?: string; startAtSec?: number; clientId: string };
/**
 * `url` is server-relative and names the viewer: `/api/sessions/<sessionId>/<clientId>/index.m3u8` (HLS)
 * or `/api/sessions/<sessionId>/<clientId>/direct`.
 */
export type PlayResponse = {
  sessionId: string;
  mode: 'hls' | 'direct';
  url: string;
  durationSec: number | null;
  startAtSec: number;
};
export type PositionReport = { itemId: number; episodeRemoteId?: string; positionSec: number; durationSec: number | null };
export type SavedPosition = {
  episodeRemoteId: string | null;
  positionSec: number;
  durationSec: number | null;
  finished: boolean;
  updatedAt: number;
};
