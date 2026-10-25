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
/** The picture-quality badge on an episode row. */
export type Quality = 'HD' | '4K';
export type Episode = { remoteId: string; title: string; episodeNum: number; durationSec: number | null };
export type Season = { season: number; episodes: Episode[] };
/** An episode with its still (a server-relative /api/art path) for the series page. */
export type EpisodeDetail = Episode & { imageUrl: string | null; airDate: string | null; quality: Quality | null };
export type SeasonDetail = { season: number; name: string; coverUrl: string | null; episodes: EpisodeDetail[] };
type DetailsBase = {
  plot: string | null;
  genre: string | null;
  cast: string | null;
  director: string | null;
  year: number | null;
  rating: string | null;
  /** A server-relative /api/art path, or null when the provider has no image. */
  posterUrl: string | null;
  backdropUrl: string | null;
};
export type ItemDetails = (
  | { kind: 'series'; seasons: SeasonDetail[] }
  | { kind: 'movie'; durationSec: number | null }
) & DetailsBase;
/** Where the watch page's Back and "more in this list" lead for a live channel. */
export type WatchContext = { categoryId: number | null; label: string | null };
export type PlayRequest = {
  itemId: number;
  episodeRemoteId?: string;
  startAtSec?: number;
  clientId: string;
  /** Plays a past (or airing) programme on a live channel instead; UTC epoch seconds. */
  catchup?: { startSec: number; stopSec: number };
  /** Movies and episodes: the audio stream to play (a `MediaTrack.index`); English, else the default, if left out. */
  audioIndex?: number;
  /** Movies and episodes: the text subtitle stream to show; null for none. */
  subtitleIndex?: number | null;
  /** Movies and episodes: when `subtitleIndex` is left out, show a text subtitle track in this language (`en`, `nld`, …). */
  subtitleLanguage?: string | null;
};
/**
 * An audio or subtitle stream of a movie or episode. `index` is its stream index in the source; `language` is
 * a 2-letter code where one is known (`en`, `nl`), else the source's tag. `available` is false for a picture
 * subtitle (PGS, DVD), which can't be shown.
 */
export type MediaTrack = { index: number; label: string; language: string | null; isDefault: boolean; forced: boolean; available: boolean };
/** A movie or episode's tracks, and the ones its session plays (null: none). */
export type SessionTracks = { audio: MediaTrack[]; subtitles: MediaTrack[]; audioIndex: number | null; subtitleIndex: number | null };
/**
 * `url` is server-relative and names the viewer: `/api/sessions/<sessionId>/<clientId>/index.m3u8` (HLS),
 * `/api/sessions/<sessionId>/<clientId>/master.m3u8` (HLS with a subtitle rendition)
 * or `/api/sessions/<sessionId>/<clientId>/direct`.
 */
export type PlayResponse = {
  sessionId: string;
  mode: 'hls' | 'direct';
  url: string;
  durationSec: number | null;
  startAtSec: number;
  /** Movie and episode HLS sessions only: null for live, catch-up and direct play (whose tracks are the player's own). */
  tracks: SessionTracks | null;
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
  /** The most recent favourites only; `favouriteCount` counts them all. */
  favourites: CatalogItem[];
  favouriteCount: number;
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
