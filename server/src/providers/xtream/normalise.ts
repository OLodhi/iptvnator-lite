import type { Kind } from '@tv/shared';

export type RawItem = {
  remoteId: string;
  name: string;
  categoryRemoteIds: string[];
  position: number | null;
  logoUrl: string | null;
  containerExt: string | null;
  epgChannelId: string | null;
  catchupDays: number | null;
  addedAt: number | null;
  rating: string | null;
  year: number | null;
};

function str(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function num(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function categories(raw: Record<string, unknown>): string[] {
  const list = Array.isArray(raw.category_ids) ? raw.category_ids : [];
  const fromList = list.map(str).filter((s): s is string => s !== null);
  if (fromList.length > 0) return fromList;
  const single = str(raw.category_id);
  return single === null ? [] : [single];
}

function year(raw: Record<string, unknown>): number | null {
  for (const v of [raw.year, raw.releaseDate, raw.release_date]) {
    const m = /^(\d{4})/.exec(str(v) ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}

export function normaliseItem(kind: Kind, raw: Record<string, unknown>): RawItem | null {
  const remoteId = str(kind === 'series' ? raw.series_id : raw.stream_id);
  const name = str(raw.name);
  if (remoteId === null || name === null) return null;
  return {
    remoteId,
    name,
    categoryRemoteIds: categories(raw),
    position: num(raw.num),
    logoUrl: str(raw.stream_icon) ?? str(raw.cover),
    containerExt: str(raw.container_extension),
    epgChannelId: str(raw.epg_channel_id),
    catchupDays: num(raw.tv_archive) === 1 ? num(raw.tv_archive_duration) : null,
    addedAt: num(raw.added),
    rating: str(raw.rating),
    year: year(raw),
  };
}

export function normaliseServerUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, '');
}
