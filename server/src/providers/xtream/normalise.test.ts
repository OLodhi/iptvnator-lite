import { expect, test } from 'vitest';
import { normaliseItem, normaliseServerUrl } from './normalise.ts';

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
