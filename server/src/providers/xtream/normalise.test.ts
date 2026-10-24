import { expect, test } from 'vitest';
import { decodeListing, normaliseItem, normaliseServerUrl } from './normalise.ts';

test('decodeListing handles numeric stamps, wall-clock fallback, plain text and bad spans', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  expect(decodeListing({ title: b64('Café News'), description: '', start_timestamp: 1000, stop_timestamp: '1600' }, null)).toEqual({
    title: 'Café News',
    description: null,
    start: 1000,
    stop: 1600,
  });
  const wall = decodeListing({ title: 'Plain title here', start: '2026-07-01 19:00:00', end: '2026-07-01 20:00:00' }, 'Europe/London');
  expect(wall).toMatchObject({ title: 'Plain title here', start: Date.UTC(2026, 6, 1, 18) / 1000, stop: Date.UTC(2026, 6, 1, 19) / 1000 });
  expect(decodeListing({ title: 'x', start_timestamp: 5, stop_timestamp: 5 }, null)).toBeNull();
  expect(decodeListing({ title: 'x' }, null)).toBeNull();
});

test('normalises messy item fields', () => {
  expect(
    normaliseItem('live', {
      stream_id: 7, name: 'BBC One', num: '3', category_id: '', category_ids: [12, '13'],
      tv_archive: '1', tv_archive_duration: '7', added: '1700000000', stream_icon: '',
    }),
  ).toEqual({
    remoteId: '7', name: 'BBC One', position: 3, categoryRemoteIds: ['12', '13'], catchupDays: 7,
    addedAt: 1700000000, logoUrl: null, containerExt: null, epgChannelId: null, rating: null, year: null,
  });
  expect(normaliseItem('series', { series_id: '9', name: 'X', releaseDate: '2019-04-01', category_id: null })).toMatchObject({
    remoteId: '9', year: 2019, categoryRemoteIds: [],
  });
  expect(normaliseItem('movie', { name: 'no id' })).toBeNull();
  expect(normaliseItem('movie', { stream_id: 1, name: '' })).toBeNull();
});

test('falls back to category_id and ignores catchup when tv_archive is off', () => {
  expect(normaliseItem('live', { stream_id: 1, name: 'A', category_id: '5', tv_archive: 0, tv_archive_duration: 3 })).toMatchObject({
    categoryRemoteIds: ['5'], catchupDays: null,
  });
});

test('normaliseServerUrl adds a scheme and trims slashes', () => {
  expect(normaliseServerUrl('example.com:8080/')).toBe('http://example.com:8080');
  expect(normaliseServerUrl(' https://x.tv// ')).toBe('https://x.tv');
});
