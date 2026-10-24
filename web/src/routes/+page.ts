import { redirect } from '@sveltejs/kit';
import type { ProviderSummary } from '@tv/shared';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
  let providers: ProviderSummary[] = [];
  try {
    const res = await fetch('/api/providers');
    if (res.ok) providers = await res.json();
  } catch {
    // server unreachable: settings is the safest place to land
  }
  redirect(307, providers.length > 0 ? '/browse/live' : '/settings/providers');
};
