import { expect, test } from 'vitest';
import { checkPublicUrl, isPublicAddress } from './publicAddress.ts';

test('private, loopback, link-local and CGNAT ranges are refused', () => {
  for (const ip of [
    '0.0.0.0', '0.1.2.3', '10.0.0.5', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.0.9', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.5', '::ffff:7f00:1', '::ffff:c0a8:101', 'not-an-ip',
  ]) {
    expect(isPublicAddress(ip), ip).toBe(false);
  }
});

test('public addresses pass', () => {
  for (const ip of ['93.184.216.34', '8.8.8.8', '100.63.255.255', '172.15.0.1', '172.32.0.1', '2606:2800:220:1::1', '::ffff:8.8.8.8']) {
    expect(isPublicAddress(ip), ip).toBe(true);
  }
});

test('a hostname resolving to any private address is refused', async () => {
  const mixed = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
  expect(await checkPublicUrl('http://img.example.com/a.png', mixed)).toBe(false);
  expect(await checkPublicUrl('http://img.example.com/a.png', async () => [{ address: '93.184.216.34' }])).toBe(true);
});

test('IP literals are checked directly; other schemes and lookup failures are refused', async () => {
  const never = async (): Promise<{ address: string }[]> => {
    throw new Error('no lookup expected');
  };
  expect(await checkPublicUrl('http://127.0.0.1/x', never)).toBe(false);
  expect(await checkPublicUrl('http://[::1]/x', never)).toBe(false);
  expect(await checkPublicUrl('http://[::ffff:127.0.0.1]/x', never)).toBe(false);
  expect(await checkPublicUrl('https://8.8.8.8/x', never)).toBe(true);
  expect(await checkPublicUrl('ftp://8.8.8.8/x', never)).toBe(false);
  expect(await checkPublicUrl('http://missing.example/x', never)).toBe(false);
  expect(await checkPublicUrl('nonsense', never)).toBe(false);
});
