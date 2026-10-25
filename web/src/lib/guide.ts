import type { GridRow, GuideMeta, GuideSource, GuideStatus, Page, Programme } from '@tv/shared';
import { api } from './api.ts';

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

function query(params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const guideMeta = () => api<GuideMeta>('/api/guide');

export function grid(
  p: { filter: string; from: number; to: number; cursor?: string | null },
  signal?: AbortSignal,
): Promise<Page<GridRow>> {
  return api<Page<GridRow>>(`/api/guide/grid${query(p)}`, signal ? { signal } : undefined);
}

export function programmes(itemIds: number[], from: number, to: number, signal?: AbortSignal): Promise<Record<string, Programme[]>> {
  return api<Record<string, Programme[]>>(`/api/guide/programmes${query({ items: itemIds.join(','), from, to })}`, signal ? { signal } : undefined);
}

export const refreshGuide = (providerId: number) => api<void>(`/api/providers/${providerId}/guide`, { method: 'POST' });
export const guideStatus = (providerId: number) => api<GuideStatus>(`/api/providers/${providerId}/guide`);

export const guideSources = (providerId: number, q: string, signal?: AbortSignal) =>
  api<GuideSource[]>(`/api/providers/${providerId}/guide/sources${query({ q })}`, signal ? { signal } : undefined);

export const setGuideSource = (itemId: number, key: string | null) => api<void>(`/api/items/${itemId}/guide-source`, json('PUT', { key }));
