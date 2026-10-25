import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The guide lives in Live now: an old link or Home Screen shortcut lands there.
export const load: PageLoad = () => {
  redirect(308, '/browse/live');
};
