import type { BrowseView } from '@tv/shared';

const names = new Map<number, string>();

/** Remembers category names from the tab screen so the category screen can title itself without a request. */
export function rememberCategories(view: BrowseView): void {
  for (const c of [...view.categories, ...view.pinned]) names.set(c.id, c.displayName);
}

/** Remembers one category's name, e.g. from a search result, before navigating to it. */
export function rememberCategoryName(id: number, displayName: string): void {
  names.set(id, displayName);
}

export const categoryName = (id: number): string | undefined => names.get(id);
