import type {
  BrowseView,
  CurationUpdate,
  CurationView,
  ImportResult,
  ItemDetails,
  Kind,
  PositionReport,
  SavedPosition,
  SearchResults,
} from '@tv/shared';
import { api } from './api.ts';

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const browse = (kind: Kind) => api<BrowseView>(`/api/me/browse/${kind}`);

export const pin = (categoryId: number) => api<void>('/api/me/pins', json('POST', { categoryId }));
export const unpin = (categoryId: number) => api<void>(`/api/me/pins/${categoryId}`, { method: 'DELETE' });

export const favourite = (itemId: number) => api<void>('/api/me/favourites', json('POST', { itemId }));
export const unfavourite = (itemId: number) => api<void>(`/api/me/favourites/${itemId}`, { method: 'DELETE' });

/** A movie's or series' plot, genre, artwork and (for a series) seasons and episodes. */
export const itemDetails = (itemId: number) => api<ItemDetails>(`/api/items/${itemId}/details`);

export const positions = (itemId: number) => api<SavedPosition[]>(`/api/me/positions/${itemId}`);
export const reportPosition = (report: PositionReport) => api<void>('/api/me/positions', ({ ...json('PUT', report), keepalive: true }));

export const search = (q: string, limit?: number, signal?: AbortSignal) =>
  api<SearchResults>(`/api/search?q=${encodeURIComponent(q)}${limit === undefined ? '' : `&limit=${limit}`}`, signal ? { signal } : undefined);

export const curation = (providerId: number, kind: Kind) => api<CurationView>(`/api/providers/${providerId}/curation/${kind}`);
export const saveCuration = (providerId: number, kind: Kind, update: CurationUpdate) =>
  api<void>(`/api/providers/${providerId}/curation/${kind}`, json('PUT', update));
export const hideCategory = (categoryId: number) => api<void>(`/api/categories/${categoryId}/hide`, { method: 'POST' });

export const importIptvnator = (providerId: number, file: File) =>
  api<ImportResult>(`/api/providers/${providerId}/import/iptvnator`, {
    method: 'POST',
    body: file,
    headers: { 'content-type': 'application/octet-stream' },
  });

export const refresh = (providerId: number) => api<void>(`/api/providers/${providerId}/sync`, { method: 'POST' });
