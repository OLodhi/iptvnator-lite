import type { ProviderSummary } from '@tv/shared';
import { api } from './api.ts';

/** The app is single-provider for now: browse the first one. */
export async function firstProvider(): Promise<ProviderSummary | undefined> {
  const providers = await api<ProviderSummary[]>('/api/providers');
  return providers[0];
}
