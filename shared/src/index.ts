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
  /** Failed syncs in a row; 0 after a success or before any attempt. */
  failures: number;
};
/** Guide refresh state for a provider. `fetchedAt` is epoch milliseconds, like `lastSyncedAt`. */
export type GuideStatus = {
  state: 'idle' | 'running' | 'failed';
  fetchedAt: number | null;
  source: 'xmltv' | 'provider' | null;
  /** Guide channels in the current generation. */
  channels: number;
  /** Programmes in the current generation. */
  programmes: number;
  /** Catalogue channels linked to a guide channel. */
  linkedChannels: number;
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
/** The programme airing now on a live channel; times are UTC epoch seconds. */
export type NowProgramme = { title: string; startSec: number; stopSec: number };
export type Programme = {
  id: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  startSec: number;
  stopSec: number;
};
export type CatalogItem = {
  id: number;
  providerId: number;
  kind: Kind;
  name: string;
  logoUrl: string | null;
  catchupDays: number | null;
  year: number | null;
  rating: string | null;
  /** The name as shown: the single visible tag group's tag stripped. */
  displayName: string;
  /** Whether the current user has favourited it. */
  favourite: boolean;
  /** Live items in lists only: what is airing now, or null when nothing is. Absent for movies and series. */
  now?: NowProgramme | null;
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
export type CurationGroup = { tag: string; friendlyName: string | null; hint: string[];
  /** The group's standing switch for the viewing user (their own, else the default); null when none was ever set. */
  rule: boolean | null;
  categories: CurationCategory[];
};
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
export type GuideView = 'whatson' | 'grid';
/** `filter` is 'all', 'favourites' or `category:${number}`. */
export type GuidePrefs = { view: GuideView; filter: string };
export type GuideChip = { filter: string; label: string };
export type GuideMeta = {
  providerId: number | null;
  chips: GuideChip[];
  prefs: GuidePrefs;
  /** Earliest start and latest stop of the current guide, epoch seconds. */
  range: { fromSec: number; toSec: number } | null;
  status: GuideStatus | null;
};
export type WhatsOnEntry = { item: CatalogItem; programme: Programme; live: boolean; catchup: boolean };
export type GridRow = { item: CatalogItem; programmes: Programme[]; hasGuide: boolean };
export type GuideSource = { key: string; name: string };
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
export type BrowseCategory = { id: number; displayName: string; itemCount: number; pinned: boolean };
export type ContinueItem = {
  item: CatalogItem;
  episodeRemoteId: string | null;
  /** "S<season> E<num>" for an episode; null for a movie or when the series info is unavailable. */
  episodeLabel: string | null;
  positionSec: number;
  durationSec: number | null;
};
export type BrowseView = {
  providerId: number | null;
  kind: Kind;
  categories: BrowseCategory[];
  pinned: BrowseCategory[];
  recent: CatalogItem[];
  favourites: CatalogItem[];
  continueWatching: ContinueItem[];
  newCategories: number;
};
export type SearchResults = {
  live: CatalogItem[];
  movie: CatalogItem[];
  series: CatalogItem[];
  categories: (BrowseCategory & { kind: Kind })[];
};
export type ImportResult = { categoriesMatched: number; hiddenApplied: number; favouritesImported: number };
