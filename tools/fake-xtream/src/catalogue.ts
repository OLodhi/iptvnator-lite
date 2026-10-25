export type FakeCategory = { id: string; name: string };
export type FakeItem = { id: number; name: string; categoryId: string; epgChannelId?: string; archiveDays?: number };
export type FakeKind = { categories: FakeCategory[]; items: FakeItem[] };
export type FakeEpisode = { id: number; season: number; num: number; title: string };
export type FakeCatalogue = {
  live: FakeKind;
  movie: FakeKind;
  series: FakeKind;
  /** Episodes keyed by series id. Series without an entry have no episodes. */
  episodes: Record<string, FakeEpisode[]>;
};

export type CatalogueCounts = {
  live: number;
  movie: number;
  series: number;
  categoriesPerKind: number;
  /** The first N live items get epgChannelId `ch<id>.gen`. */
  guideChannels?: number;
  /** This percentage of those guide channels also get 7 days of archive. */
  archivePercent?: number;
};

const LIVE_TAGS = ['UK| ', 'US| ', 'AR| '];
const VOD_TAGS = ['|EN| ', '|FR| '];
const TOPICS = ['Sports', 'News', 'Movies', 'Kids', 'Music', 'Documentary', 'Drama', 'Comedy', 'Action', 'Family'];
const WORDS = ['Alpha', 'Bravo', 'Cedar', 'Delta', 'Ember', 'Falcon', 'Garnet', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lumen'];
// Like real titles, a third start with "The" and a third with "A", so common search words match a large share.
const ARTICLES = ['The ', 'A ', ''];

function makeKind(count: number, categories: number, tags: string[], label: string): FakeKind {
  const cats: FakeCategory[] = [];
  for (let i = 0; i < categories; i++) {
    // Every 20th category is untagged (5%).
    const tag = i % 20 === 19 ? '' : tags[i % tags.length]!;
    cats.push({ id: String(i + 1), name: `${tag}${TOPICS[i % TOPICS.length]} ${i + 1}` });
  }
  const items: FakeItem[] = [];
  for (let i = 0; i < count; i++) {
    const cat = categories > 0 ? cats[i % categories]! : undefined;
    const tag = cat && /^(\w{2}\| |\|\w{2}\| )/.exec(cat.name)?.[0];
    items.push({
      id: i + 1,
      name: `${tag ?? ''}${ARTICLES[i % ARTICLES.length]}${label} ${WORDS[i % WORDS.length]} ${i + 1}`,
      categoryId: cat?.id ?? '1',
    });
  }
  return { categories: cats, items };
}

export function generateCatalogue(counts: CatalogueCounts): FakeCatalogue {
  const live = makeKind(counts.live, counts.categoriesPerKind, LIVE_TAGS, 'Channel');
  const guided = Math.min(counts.guideChannels ?? 0, live.items.length);
  const archived = counts.archivePercent ?? 0;
  for (let i = 0; i < guided; i++) {
    const item = live.items[i]!;
    item.epgChannelId = `ch${item.id}.gen`;
    // Spread evenly: exactly archivePercent of every 100 guide channels.
    if (Math.floor(((i + 1) * archived) / 100) > Math.floor((i * archived) / 100)) item.archiveDays = 7;
  }
  return {
    live,
    movie: makeKind(counts.movie, counts.categoriesPerKind, VOD_TAGS, 'Movie'),
    series: makeKind(counts.series, counts.categoriesPerKind, VOD_TAGS, 'Series'),
    episodes: {},
  };
}

export function smallCatalogue(): FakeCatalogue {
  return {
    live: {
      categories: [
        { id: '1', name: 'UK| General' },
        { id: '2', name: 'US| News' },
        { id: '3', name: 'Misc' },
      ],
      items: [
        { id: 1, name: 'UK| HLS Channel', categoryId: '1', epgChannelId: 'hls.uk', archiveDays: 2 },
        { id: 2, name: 'UK| Raw TS Channel', categoryId: '1', epgChannelId: 'raw.uk' },
        { id: 3, name: 'US| MPEG-2 Channel', categoryId: '2' },
        { id: 999, name: 'Misc Dead Channel', categoryId: '3' },
      ],
    },
    movie: {
      categories: [
        { id: '10', name: '|EN| Action' },
        { id: '11', name: '|FR| Drame' },
      ],
      items: [
        { id: 1, name: '|EN| MKV Movie', categoryId: '10' },
        { id: 2, name: '|EN| MP4 Movie', categoryId: '10' },
        { id: 3, name: '|FR| HEVC Movie', categoryId: '11' },
      ],
    },
    series: {
      categories: [{ id: '20', name: '|EN| Drama' }],
      items: [{ id: 10, name: '|EN| Test Series', categoryId: '20' }],
    },
    episodes: {
      '10': [
        { id: 101, season: 1, num: 1, title: 'Pilot' },
        { id: 102, season: 1, num: 2, title: 'Second' },
        { id: 201, season: 2, num: 1, title: 'Return' },
      ],
    },
  };
}

/** smallCatalogue() plus the watch-page fixtures: movie 5 (two audio, two subtitle tracks) and series 11 (rich info, partial seasons). */
export function richCatalogue(): FakeCatalogue {
  const base = smallCatalogue();
  const kitchen = 'EN - THE KITCHEN (2022)';
  return {
    ...base,
    movie: {
      ...base.movie,
      items: [...base.movie.items, { id: 5, name: 'EN - Multi Track (2021)', categoryId: '10' }],
    },
    series: {
      ...base.series,
      items: [...base.series.items, { id: 11, name: kitchen, categoryId: '20' }],
    },
    episodes: {
      ...base.episodes,
      '11': [
        { id: 111, season: 1, num: 1, title: `${kitchen} - S01E01 - Pilot` },
        { id: 112, season: 1, num: 2, title: `${kitchen} - S01E02 - Rush` },
        { id: 121, season: 2, num: 1, title: `${kitchen} - S02E01 - Review` },
        { id: 100, season: 0, num: 1, title: 'Behind the scenes' },
      ],
    },
  };
}
