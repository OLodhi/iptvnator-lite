import Database from 'better-sqlite3';
import type { CurationUpdate, ImportResult, Kind } from '@tv/shared';
import type { CurationService } from '../curation/service.ts';
import type { Db } from '../db/db.ts';
import type { PersonalService } from '../personal/service.ts';
import { createProviderRepo } from '../providers/repo.ts';
import { normaliseServerUrl } from '../providers/xtream/normalise.ts';

export class ImportError extends Error {
  readonly code: 'NOT_IPTVNATOR' | 'NO_MATCHING_PLAYLIST';
  constructor(code: ImportError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const KINDS: Kind[] = ['live', 'movie', 'series'];
const REQUIRED_TABLES = ['playlists', 'categories', 'content', 'favorites'];
const NOT_IPTVNATOR = 'The file is not an IPTVnator database';

type TheirCategory = { kind: Kind; remoteId: string; hidden: boolean };
type TheirFavourite = { kind: Kind; remoteId: string };
type Theirs = { categories: TheirCategory[]; favourites: TheirFavourite[] };

const sameUrl = (a: string, b: string) => normaliseServerUrl(a).toLowerCase() === normaliseServerUrl(b).toLowerCase();

const kindOf = (type: string): Kind | null =>
  type === 'movies' || type === 'movie' ? 'movie' : type === 'live' || type === 'series' ? type : null;

/** Everything needed from IPTVnator's database, read before anything is written to ours. */
function readTheirs(file: string, server: string, username: string): Theirs {
  let theirs: Database.Database;
  try {
    theirs = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    throw new ImportError('NOT_IPTVNATOR', NOT_IPTVNATOR);
  }
  try {
    let playlists: { id: string; serverUrl: string | null; username: string | null }[];
    try {
      const tables = new Set(theirs.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all() as string[]);
      if (!REQUIRED_TABLES.every((t) => tables.has(t))) throw new Error('missing tables');
      // The password column is never selected.
      playlists = theirs.prepare(`SELECT id, serverUrl, username FROM playlists WHERE type = 'xtream'`).all() as typeof playlists;
    } catch {
      throw new ImportError('NOT_IPTVNATOR', NOT_IPTVNATOR);
    }
    const playlist = playlists.find((p) => p.serverUrl && sameUrl(p.serverUrl, server) && p.username === username);
    if (!playlist) throw new ImportError('NO_MATCHING_PLAYLIST', 'The file has no playlist for this provider');

    let categories: { type: string; xtreamId: number | null; hidden: number }[];
    let favourites: { type: string; xtreamId: number | null }[];
    try {
      categories = theirs
        .prepare('SELECT type, xtream_id AS xtreamId, hidden FROM categories WHERE playlist_id = ?')
        .all(playlist.id) as typeof categories;
      favourites = theirs
        .prepare(
          `SELECT c.type AS type, c.xtream_id AS xtreamId FROM favorites f JOIN content c ON c.id = f.content_id
            WHERE f.playlist_id = ? ORDER BY f.id`,
        )
        .all(playlist.id) as typeof favourites;
    } catch {
      throw new ImportError('NOT_IPTVNATOR', NOT_IPTVNATOR);
    }
    const out: Theirs = { categories: [], favourites: [] };
    for (const c of categories) {
      const kind = kindOf(c.type);
      if (kind && c.xtreamId !== null) out.categories.push({ kind, remoteId: String(c.xtreamId), hidden: c.hidden === 1 });
    }
    for (const f of favourites) {
      const kind = kindOf(f.type);
      if (kind && f.xtreamId !== null) out.favourites.push({ kind, remoteId: String(f.xtreamId) });
    }
    return out;
  } finally {
    theirs.close();
  }
}

/**
 * Per kind, hidden categories become standing rules the way the picker would write them: a tag group's switch is the
 * majority of its matched categories (a tie shows), the rest are exceptions; untagged categories get their own rule.
 */
function curationFor(matched: { remoteId: string; tag: string | null; visible: boolean }[]): {
  update: CurationUpdate;
  hidden: number;
} {
  const update: CurationUpdate = { tags: {}, categories: {} };
  const groups = new Map<string, typeof matched>();
  for (const c of matched) {
    if (c.tag !== null) groups.set(c.tag, [...(groups.get(c.tag) ?? []), c]);
  }
  for (const [tag, members] of groups) {
    const shown = members.filter((m) => m.visible).length;
    const groupVisible = shown >= members.length - shown;
    update.tags[tag] = groupVisible;
    for (const m of members) if (m.visible !== groupVisible) update.categories[m.remoteId] = m.visible;
  }
  for (const c of matched) if (c.tag === null) update.categories[c.remoteId] = c.visible;
  const hidden = matched.filter((c) => (update.categories[c.remoteId] ?? update.tags[c.tag!]) === false).length;
  return { update, hidden };
}

export function importIptvnator(
  deps: { db: Db; curation: CurationService; personal: PersonalService },
  input: { file: string; providerId: number; userId: number },
): ImportResult {
  const provider = createProviderRepo(deps.db).get(input.providerId);
  if (!provider) throw new Error(`Provider ${input.providerId} not found`);
  const { serverUrl, username } = provider.config;
  const theirs = readTheirs(input.file, serverUrl, username);

  const ours = deps.db.prepare('SELECT remote_id AS remoteId, tag FROM categories WHERE provider_id = ? AND kind = ?');
  const item = deps.db.prepare('SELECT id FROM items WHERE provider_id = ? AND kind = ? AND remote_id = ?').pluck();
  const result: ImportResult = { categoriesMatched: 0, hiddenApplied: 0, favouritesImported: 0 };

  // One transaction: a failure part-way leaves no rules or favourites behind (the saves nest as savepoints).
  deps.db.transaction(() => {
    for (const kind of KINDS) {
      const tagOf = new Map(
        (ours.all(input.providerId, kind) as { remoteId: string; tag: string | null }[]).map((c) => [c.remoteId, c.tag]),
      );
      const matched = theirs.categories
        .filter((c) => c.kind === kind && tagOf.has(c.remoteId))
        .map((c) => ({ remoteId: c.remoteId, tag: tagOf.get(c.remoteId)!, visible: !c.hidden }));
      if (matched.length === 0) continue;
      const { update, hidden } = curationFor(matched);
      deps.curation.save(input.providerId, kind, update, null);
      result.categoriesMatched += matched.length;
      result.hiddenApplied += hidden;
    }

    for (const f of theirs.favourites) {
      const id = item.get(input.providerId, f.kind, f.remoteId) as number | undefined;
      if (id !== undefined && deps.personal.addFavourite(input.userId, id)) result.favouritesImported++;
    }
  })();
  return result;
}
