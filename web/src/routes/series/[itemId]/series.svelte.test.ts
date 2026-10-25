import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Snapshot } from '@sveltejs/kit';
import type { CatalogItem, EpisodeDetail, ItemDetails, SavedPosition, SeasonDetail } from '@tv/shared';

type SeriesDetails = ItemDetails & { kind: 'series' };
type AfterNav = (nav: { from: { url: URL | null } | null; to: { url: URL } | null }) => void;

const route = vi.hoisted(() => ({ params: { itemId: '11' } as Record<string, string> }));
const nav = vi.hoisted(() => ({ goto: vi.fn(async (_u: string, _opts?: object) => {}), after: undefined as AfterNav | undefined }));
const net = vi.hoisted(() => ({ api: vi.fn() }));
const me = vi.hoisted(() => ({
  itemDetails: vi.fn(),
  positions: vi.fn(),
  favourite: vi.fn(),
  unfavourite: vi.fn(),
  markWatched: vi.fn(),
}));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$app/navigation', () => ({ goto: nav.goto, afterNavigate: (cb: AfterNav) => (nav.after = cb) }));
vi.mock('$lib/api', async (orig) => ({ ...(await orig<typeof import('$lib/api')>()), api: net.api }));
vi.mock('$lib/me', () => me);

import Series from './+page.svelte';

let app: ReturnType<typeof mount> | undefined;

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 11, providerId: 1, kind: 'series', name: 'EN - THE BEAR (2022)', displayName: 'The Bear', logoUrl: '/api/logos/11',
  catchupDays: null, year: 2022, rating: '8.0', favourite: false, ...over,
});
const ep = (remoteId: string, episodeNum: number, title: string): EpisodeDetail => ({
  remoteId, title, episodeNum, durationSec: 1980, imageUrl: null, airDate: null, quality: null,
});
const season = (n: number, episodes: EpisodeDetail[]): SeasonDetail => ({
  season: n, name: n === 0 ? 'Specials' : `Season ${n}`, coverUrl: null, episodes,
});
// As the server sends them: seasons in number order, so the specials first.
const bear = (over: Partial<SeriesDetails> = {}): SeriesDetails => ({
  kind: 'series',
  plot: "A young chef from the fine-dining world comes home to Chicago to run his late brother's chaotic sandwich shop.",
  genre: 'Drama · Comedy',
  cast: 'Jeremy Allen White, Ebon Moss-Bachrach',
  director: 'Christopher Storer',
  year: 2022,
  rating: '8.0',
  posterUrl: '/api/art/11/poster',
  backdropUrl: '/api/art/11/backdrop',
  seasons: [
    season(0, [ep('900', 1, 'Behind the Scenes')]),
    season(1, [ep('111', 1, 'System'), ep('112', 2, 'Hands')]),
    season(2, [ep('121', 1, 'Beef'), ep('122', 2, 'Pasta')]),
    season(3, [ep('131', 1, 'Tomorrow'), ep('132', 2, 'Next')]),
  ],
  ...over,
});
const pos = (episodeRemoteId: string, over: Partial<SavedPosition> = {}): SavedPosition => ({
  episodeRemoteId, positionSec: 0, durationSec: 1980, finished: false, manual: false, updatedAt: 1, ...over,
});
/** Marked watched by hand. */
const marked = (episodeRemoteId: string): SavedPosition => pos(episodeRemoteId, { positionSec: 1980, finished: true, manual: true, updatedAt: 9 });

function serve(details: ItemDetails, saved: SavedPosition[] = [], it: CatalogItem = item()) {
  me.itemDetails.mockResolvedValue(details);
  me.positions.mockResolvedValue(saved);
  net.api.mockImplementation(async (path: string) => {
    if (path === '/api/items/11') return it;
    throw new Error(`unexpected ${path}`);
  });
}
async function open() {
  if (app) unmount(app);
  app = mount(Series, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('.hero')).toBeTruthy());
  flushSync();
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const texts = (selector: string) => [...document.querySelectorAll(selector)].map(text);
const rowTitles = () => texts('.ep-row .n');
const rows = () => [...document.querySelectorAll<HTMLElement>('.ep-row')];
const seasonButton = () => document.querySelector<HTMLButtonElement>('.season-button')!;
const menuButton = () => document.querySelector<HTMLButtonElement>('.hero .menu')!;
const backButton = () => document.querySelector<HTMLButtonElement>('.round.back')!;
/** A sheet's choices, without the ✓ on the selected one. */
const sheetLabels = () => [...document.querySelectorAll('.sheet-action:not(.cancel)')].map((b) => b.textContent!.replace('✓', ''));
const sheetButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.sheet-action')].find((b) => b.textContent!.replace('✓', '') === label);
function click(el: HTMLElement | undefined) {
  el!.click();
  flushSync();
}
async function longPress(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  await new Promise((r) => setTimeout(r, 560));
  el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  flushSync();
}
/** jsdom lays nothing out: make the plot taller than its two clamped lines. */
function plotOverflows() {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('plot') ? 120 : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('plot') ? 40 : 0;
  });
}

beforeEach(() => {
  route.params = { itemId: '11' };
  nav.goto.mockReset();
  nav.after = undefined;
  net.api.mockReset();
  me.itemDetails.mockReset();
  me.positions.mockReset();
  me.favourite.mockReset().mockResolvedValue(undefined);
  me.unfavourite.mockReset().mockResolvedValue(undefined);
  me.markWatched.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

test('header shows chips, a 2-line plot with More, the people line and the Continue label with time left', async () => {
  plotOverflows();
  // 18 of 33 minutes into S3 E2.
  serve(bear(), [pos('131', { finished: true, positionSec: 1980 }), pos('132', { positionSec: 1080, updatedAt: 5 })]);
  await open();

  expect(text(document.querySelector('.hero h1'))).toBe('The Bear');
  expect(texts('.chips span')).toEqual(['2022', 'Drama · Comedy', '★ 8.0', '3 seasons']);
  expect(document.querySelector('.backdrop img')!.getAttribute('src')).toBe('/api/art/11/backdrop');
  expect(document.querySelector('.backdrop img')!.classList.contains('blurred')).toBe(false);
  expect(document.querySelector('.poster img')!.getAttribute('src')).toBe('/api/art/11/poster');

  const plot = document.querySelector('.plot')!;
  const toggle = document.querySelector<HTMLButtonElement>('.plot-toggle')!;
  expect(plot.classList.contains('open')).toBe(false);
  expect(toggle.textContent).toBe('More');
  click(toggle);
  expect(plot.classList.contains('open')).toBe(true);
  expect(toggle.textContent).toBe('Less');
  click(toggle);
  expect(plot.classList.contains('open')).toBe(false);

  expect(text(document.querySelector('.people'))).toBe('Created by Christopher Storer · Jeremy Allen White, Ebon Moss-Bachrach');

  const cta = document.querySelector<HTMLAnchorElement>('a.play')!;
  expect(text(cta.querySelector('.label'))).toBe('▶ Continue S3 E2 · 15 min left');
  expect(cta.getAttribute('href')).toBe('/watch?item=11&episode=132');
  expect((cta.querySelector('.pbar i') as HTMLElement).style.width).toBe('55%');

  const star = document.querySelector<HTMLButtonElement>('.fav')!;
  expect(star.getAttribute('aria-pressed')).toBe('false');
  click(star);
  expect(star.getAttribute('aria-pressed')).toBe('true');
  expect(me.favourite).toHaveBeenCalledWith(11);
});

test('missing backdrop falls back to the poster blurred, and missing plot and cast are omitted', async () => {
  serve(bear({ backdropUrl: null, plot: null, cast: null, director: null, genre: null, rating: null, year: null }), [], item({ year: null, rating: null }));
  await open();
  const backdrop = () => document.querySelector('.backdrop img');
  expect(backdrop()!.getAttribute('src')).toBe('/api/art/11/poster');
  expect(backdrop()!.classList.contains('blurred')).toBe(true);
  expect(document.querySelector('.plot')).toBeNull();
  expect(document.querySelector('.people')).toBeNull();
  expect(texts('.chips span')).toEqual(['3 seasons']);
  // A fresh series with specials starts at S1 E1: the specials come last.
  expect(text(document.querySelector('a.play .label'))).toBe('▶ Play S1 E1');
  expect(document.querySelector('a.play .pbar')).toBeNull();

  // Only a director; and a backdrop that fails to load gives way to the poster too.
  serve(bear({ cast: null }));
  await open();
  expect(text(document.querySelector('.people'))).toBe('Created by Christopher Storer');
  backdrop()!.dispatchEvent(new Event('error'));
  flushSync();
  expect(backdrop()!.getAttribute('src')).toBe('/api/art/11/poster');
  expect(backdrop()!.classList.contains('blurred')).toBe(true);

  // No artwork at all: a lettered tile for the poster, and no backdrop image.
  serve(bear({ backdropUrl: null, posterUrl: null }), [], item({ logoUrl: null }));
  await open();
  expect(backdrop()).toBeNull();
  expect(document.querySelector('.poster .tile')).not.toBeNull();
});

test('opens on the target season; the sheet switches season', async () => {
  serve(bear(), [pos('121', { positionSec: 600, updatedAt: 5 })]);
  await open();
  expect(document.querySelector('.plot-toggle')).toBeNull(); // the plot fits in two lines: no More

  expect(text(seasonButton())).toBe('Season 2 ▾');
  expect(rowTitles()).toEqual(['1 · Beef', '2 · Pasta']);
  const upNext = document.querySelector('.ep-row.current')!;
  expect(text(upNext.querySelector('.n'))).toBe('1 · Beef');
  expect(text(upNext.querySelector('.flag'))).toBe('Up next');
  expect(upNext.getAttribute('href')).toBe('/watch?item=11&episode=121');

  click(seasonButton());
  expect(document.querySelector('.sheet-title')?.textContent).toBe('Choose a season');
  click(sheetButton('Season 1 · 2 episodes'));
  expect(document.querySelector('.sheet')).toBeNull();
  expect(text(seasonButton())).toBe('Season 1 ▾');
  expect(rowTitles()).toEqual(['1 · System', '2 · Hands']);
  expect(document.querySelector('.ep-row.current')).toBeNull();
});

test('season 0 is Specials and the season list comes from episodes', async () => {
  // The provider lists seasons 1 and 2, but the episodes are in 0, 1 and 3. Season 1 repeats an episode number, and one
  // title had no SxxEyy to strip, so it arrives raw.
  serve(
    bear({
      seasons: [
        season(0, [ep('900', 1, 'Behind the Scenes')]),
        season(1, [ep('111', 1, 'System'), ep('113', 1, 'EN - THE BEAR - Pilot (Extended)')]),
        season(3, [ep('131', 1, 'Tomorrow')]),
      ],
    }),
  );
  await open();
  expect(texts('.chips span')).toContain('2 seasons');
  expect(text(seasonButton())).toBe('Season 1 ▾'); // the first season, not the specials
  expect(rowTitles()).toEqual(['1 · System', '1 · EN - THE BEAR - Pilot (Extended)']);

  click(seasonButton());
  expect(sheetLabels()).toEqual(['Season 1 · 2 episodes', 'Season 3 · 1 episode', 'Specials · 1 episode']);
  click(sheetButton('Specials · 1 episode'));
  expect(text(seasonButton())).toBe('Specials ▾');
  expect(rowTitles()).toEqual(['1 · Behind the Scenes']);
});

test('long-press marks watched and refreshes', async () => {
  // S1 E1 played to the end: Play next S1 E2.
  serve(bear(), [pos('111', { finished: true, positionSec: 1980 })]);
  await open();
  expect(text(document.querySelector('a.play .label'))).toBe('▶ Play next: S1 E2');

  me.positions.mockResolvedValue([pos('111', { finished: true, positionSec: 1980 }), marked('112')]);
  await longPress(rows()[1]!);
  expect(document.querySelector('.sheet-title')?.textContent).toBe('2 · Hands');
  click(sheetButton('Mark as watched'));
  await vi.waitFor(() => expect(text(rows()[1]!.querySelector('.s'))).toBe('watched'));
  expect(me.markWatched).toHaveBeenCalledWith(11, ['112'], true);
  expect(me.positions).toHaveBeenCalledTimes(2);
  expect(text(document.querySelector('a.play .label'))).toBe('▶ Play next: S1 E2'); // a mark never moves it

  me.positions.mockResolvedValue([pos('111', { finished: true, positionSec: 1980 })]);
  await longPress(rows()[1]!);
  click(sheetButton('Mark as unwatched'));
  await vi.waitFor(() => expect(text(rows()[1]!.querySelector('.s'))).toBe('33 min'));
  expect(me.markWatched).toHaveBeenLastCalledWith(11, ['112'], false);
  expect(me.positions).toHaveBeenCalledTimes(3);
});

test('Mark season watched sends every episode', async () => {
  // Halfway through S2 E2.
  serve(bear(), [pos('122', { positionSec: 600, updatedAt: 5 })]);
  await open();
  expect(text(seasonButton())).toBe('Season 2 ▾');
  expect(text(document.querySelector('.shead .summary'))).toBe('2 episodes');

  me.positions.mockResolvedValue([marked('121'), marked('122')]);
  click(menuButton());
  click(sheetButton('Mark season watched'));
  await vi.waitFor(() => expect(text(document.querySelector('.shead .summary'))).toBe('2 episodes · watched'));
  expect(me.markWatched).toHaveBeenCalledTimes(1);
  expect(me.markWatched).toHaveBeenCalledWith(11, ['121', '122'], true);
  expect(text(seasonButton())).toBe('Season 2 ▾'); // the page stays on the season

  // A daily show's long season goes in batches the server takes (500 at most), every episode once.
  const daily = Array.from({ length: 1200 }, (_, i) => ep(`d${i + 1}`, i + 1, `Show ${i + 1}`));
  serve(bear({ seasons: [season(1, daily)] }));
  await open();
  me.markWatched.mockClear();
  click(menuButton());
  click(sheetButton('Mark season watched'));
  await vi.waitFor(() => expect(me.markWatched).toHaveBeenCalledTimes(3));
  const sent = me.markWatched.mock.calls.map(([, ids]) => ids as string[]);
  expect(sent.map((ids) => ids.length)).toEqual([500, 500, 200]);
  expect(sent.flat()).toEqual(daily.map((e) => e.remoteId));
});

test('hide watched removes watched rows and persists', async () => {
  serve(bear(), [pos('111', { finished: true, positionSec: 1980 })]);
  await open();
  expect(rowTitles()).toEqual(['1 · System', '2 · Hands']);

  click(menuButton());
  click(sheetButton('Hide watched episodes'));
  expect(rowTitles()).toEqual(['2 · Hands']);
  expect(localStorage.getItem('tv.hideWatched')).toBe('1');

  // Per device: it is still on when the page opens again.
  await open();
  expect(rowTitles()).toEqual(['2 · Hands']);
  click(menuButton());
  click(sheetButton('Show watched episodes'));
  expect(rowTitles()).toEqual(['1 · System', '2 · Hands']);
  expect(localStorage.getItem('tv.hideWatched')).toBeNull();
});

test('Back returns where you came from, else to the series list', async () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  const to = { url: new URL('http://localhost/series/11') };
  serve(bear());

  // Opened from outside the app: SvelteKit's first navigation comes from a page with no URL.
  await open();
  expect(() => nav.after!({ from: { url: null }, to })).not.toThrow();
  click(backButton());
  expect(back).not.toHaveBeenCalled();
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/series', { replaceState: true });

  // From another page of the app, which the page remembers for when it is returned to.
  await open();
  nav.after!({ from: { url: new URL('http://localhost/search') }, to });
  expect((app!.snapshot as Snapshot<boolean>).capture()).toBe(true);
  click(backButton());
  expect(back).toHaveBeenCalledTimes(1);

  // From the watch page, which replaced its own entry (its Back without history): nothing in-app behind.
  const fromWatch = { from: { url: new URL('http://localhost/watch?item=11&episode=111') }, to };
  await open();
  nav.after!(fromWatch);
  click(backButton());
  expect(back).toHaveBeenCalledTimes(1);
  expect(nav.goto).toHaveBeenCalledTimes(2);
  expect(nav.goto).toHaveBeenLastCalledWith('/browse/series', { replaceState: true });

  // Back from an episode to a page first opened from the app: SvelteKit restores what the page knew then.
  await open();
  nav.after!(fromWatch);
  (app!.snapshot as Snapshot<boolean>).restore(true);
  click(backButton());
  expect(back).toHaveBeenCalledTimes(2);
});
