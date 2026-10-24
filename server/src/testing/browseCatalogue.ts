import type { FakeCatalogue } from '../../../tools/fake-xtream/src/catalogue.ts';

/** Two tag groups (UK, US) and an untagged category for live; one tag group (EN) for movies and series. */
export const browseCatalogue = (): FakeCatalogue => ({
  live: {
    categories: [
      { id: '1', name: 'UK| Sports' },
      { id: '2', name: 'UK| News' },
      { id: '3', name: 'US| Sports' },
      { id: '5', name: 'US| Talk' },
      { id: '4', name: 'Misc' },
    ],
    items: [
      { id: 1, name: 'UK| Sky Sports 1', categoryId: '1' },
      { id: 2, name: 'UK| BBC News', categoryId: '2' },
      { id: 3, name: 'US| ESPN Sport', categoryId: '3' },
      { id: 4, name: 'Café Plus', categoryId: '4' },
      { id: 5, name: 'US| Late Show', categoryId: '5' },
    ],
  },
  movie: {
    categories: [
      { id: '10', name: '|EN| Action' },
      { id: '11', name: '|EN| Comedy' },
    ],
    items: [
      { id: 1, name: '|EN| Sporting Chance', categoryId: '10' },
      { id: 2, name: '|EN| Bukowski Days', categoryId: '10' },
      { id: 3, name: '|EN| Funny Bones', categoryId: '11' },
    ],
  },
  series: {
    categories: [
      { id: '20', name: '|EN| Sport Stories' },
      { id: '21', name: '|EN| Crime' },
    ],
    items: [
      { id: 10, name: '|EN| Sport Series', categoryId: '20' },
      { id: 11, name: '|EN| Crime Stuff', categoryId: '21' },
    ],
  },
  episodes: {
    '10': [
      { id: 101, season: 1, num: 1, title: 'Pilot' },
      { id: 102, season: 1, num: 2, title: 'Second' },
      { id: 201, season: 2, num: 3, title: 'Return' },
    ],
  },
});
