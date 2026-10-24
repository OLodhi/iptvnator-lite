export type FakeCategory = { id: string; name: string };
export type FakeItem = { id: number; name: string; categoryId: string };
export type FakeKind = { categories: FakeCategory[]; items: FakeItem[] };
export type FakeEpisode = { id: number; season: number; num: number; title: string };
export type FakeCatalogue = {
  live: FakeKind;
  movie: FakeKind;
  series: FakeKind;
  /** Episodes keyed by series id. Series without an entry have no episodes. */
  episodes: Record<string, FakeEpisode[]>;
};

export type CatalogueCounts = { live: number; movie: number; series: number; categoriesPerKind: number };

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
  return {
    live: makeKind(counts.live, counts.categoriesPerKind, LIVE_TAGS, 'Channel'),
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
        { id: 1, name: 'UK| HLS Channel', categoryId: '1' },
        { id: 2, name: 'UK| Raw TS Channel', categoryId: '1' },
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
