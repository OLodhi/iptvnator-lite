import type { BrowseView } from '@tv/shared';

const names = new Map<number, string>();

/** Remembers category names from the tab screen so the category screen can title itself without a request. */
export function rememberCategories(view: BrowseView): void {
  for (const c of [...view.categories, ...view.pinned]) names.set(c.id, c.displayName);
}

export const categoryName = (id: number): string | undefined => names.get(id);
