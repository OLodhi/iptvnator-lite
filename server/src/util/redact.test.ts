import { expect, test } from 'vitest';
import { redactUrl } from './redact.ts';

test('redactUrl hides credentials in queries and paths', () => {
  expect(redactUrl('http://h:80/player_api.php?username=bob&password=s3cret&action=x')).toBe(
    'http://h:80/player_api.php?username=***&password=***&action=x',
  );
  expect(redactUrl('http://h/live/bob/s3cret/12.m3u8')).toBe('http://h/live/***/***/12.m3u8');
  expect(redactUrl('http://h/series/bob/s3cret/101.mkv')).toBe('http://h/series/***/***/101.mkv');
  expect(redactUrl('http://h/movie/bob/s3cret/1.mkv')).toBe('http://h/movie/***/***/1.mkv');
});
