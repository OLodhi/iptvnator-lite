import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { maybeGunzip, parseXmltv, parseXmltvTime } from './xmltv.ts';
import type { XmltvChannel, XmltvProgramme } from './xmltv.ts';

const Z = Date.UTC(2026, 6, 1, 18, 0) / 1000;

async function collect(source: Readable) {
  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];
  const counts = await parseXmltv(source, {
    channel: (c) => { channels.push(c); },
    programme: (p) => { programmes.push(p); },
  });
  return { channels, programmes, counts };
}

const wrap = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><tv>${body}</tv>`;
const prog = (attrs: string, inner: string) => `<programme ${attrs}>${inner}</programme>`;
const good = 'start="20260701190000 +0100" stop="20260701200000 +0100" channel="a"';

const FIXTURE = wrap(`
  <channel id="a"><display-name>UK| BBC 1</display-name><display-name>BBC One</display-name></channel>
  <channel id="b"><display-name>ITV 1 ᴴᴰ</display-name></channel>
  ${prog(good, '<title lang="en">News</title><sub-title>Late</sub-title><desc>  Daily   news </desc><category>News</category>')}
  ${prog('start="20260701200000 +0100" stop="20260701210000 +0100" channel="a"', '<title>Film</title>')}
  ${prog('start="20260701180000" stop="20260701190000" channel="b"', '<title>Quiz</title>')}
`);

test('parses offsets, missing offsets and short times', () => {
  expect(parseXmltvTime('20260701190000 +0100')).toBe(Z);
  expect(parseXmltvTime('20260701180000')).toBe(Z);
  expect(parseXmltvTime('202607011800 +0000')).toBe(Z);
  expect(parseXmltvTime('20260701190000 +01:00')).toBe(Z);
  expect(parseXmltvTime('2026-07-01')).toBeNull();
});

test('reads channels and programmes', async () => {
  const r = await collect(Readable.from([FIXTURE]));
  expect(r.channels).toEqual([
    { id: 'a', names: ['UK| BBC 1', 'BBC One'] },
    { id: 'b', names: ['ITV 1 ᴴᴰ'] },
  ]);
  expect(r.programmes[0]).toEqual({ channel: 'a', start: Z, stop: Z + 3600, title: 'News', subtitle: 'Late', description: 'Daily news', category: 'News' });
  expect(r.programmes[1]).toMatchObject({ title: 'Film', subtitle: null, description: null, category: null });
  expect(r.programmes[2]).toMatchObject({ channel: 'b', start: Z, title: 'Quiz' });
  expect(r.counts).toEqual({ channels: 2, programmes: 3, skipped: 0 });
});

test('keeps the first title and skips bad programmes', async () => {
  const xml = wrap([
    prog(good, '<title lang="en">First</title><title lang="fr">Second</title>'),
    prog('start="20260701190000 +0100" channel="a"', '<title>No stop</title>'),
    prog('start="20260701200000 +0100" stop="20260701200000 +0100" channel="a"', '<title>Zero</title>'),
    prog('start="garbage" stop="20260701200000 +0100" channel="a"', '<title>Bad date</title>'),
    prog('start="20260701190000 +0100" stop="20260701200000 +0100"', '<title>No channel</title>'),
    prog(good, '<title>  </title>'),
  ].join(''));
  const r = await collect(Readable.from([xml]));
  expect(r.programmes.map((p) => p.title)).toEqual(['First']);
  expect(r.counts).toEqual({ channels: 0, programmes: 1, skipped: 5 });
});

test('decodes entities and CDATA', async () => {
  const xml = wrap(prog(good, '<title>Tom &amp; Jerry</title><desc><![CDATA[A < B]]></desc>'));
  const r = await collect(Readable.from([xml]));
  expect(r.programmes[0]).toMatchObject({ title: 'Tom & Jerry', description: 'A < B' });
});

test('gunzips raw gzip transparently', async () => {
  const plain = await collect(Readable.from([Buffer.from(FIXTURE)]));
  const zipped = await collect(maybeGunzip(Readable.from([gzipSync(FIXTURE)])));
  const unzipped = await collect(maybeGunzip(Readable.from([Buffer.from(FIXTURE)])));
  expect(zipped).toEqual(plain);
  expect(unzipped).toEqual(plain);
});

test('maybeGunzip keeps every byte of empty and one-byte streams', async () => {
  const read = async (s: Readable) => { const b: Buffer[] = []; for await (const c of s) b.push(Buffer.from(c)); return Buffer.concat(b); };
  expect((await read(maybeGunzip(Readable.from([])))).length).toBe(0);
  expect([...(await read(maybeGunzip(Readable.from([Buffer.from([0x1f])]))))]).toEqual([0x1f]);
  expect(await read(maybeGunzip(Readable.from([Buffer.from('<'), Buffer.from('tv/>')])))).toEqual(Buffer.from('<tv/>'));
});

test('waits for async handlers', async () => {
  // One programme per chunk so the stream has data waiting while a handler is pending.
  const chunks = ['<tv>', ...Array.from({ length: 5 }, (_, i) => prog(good, `<title>P${i}</title>`)), '</tv>'];
  const source = Readable.from(chunks);
  let pending = 0;
  let pausedWhilePending = 0;
  const seen: string[] = [];
  await parseXmltv(source, {
    channel() {},
    async programme(p) {
      pending++;
      if (pending > 1) throw new Error('overlapping handlers');
      await new Promise((r) => setTimeout(r, 5));
      if (source.isPaused()) pausedWhilePending++;
      seen.push(p.title);
      pending--;
    },
  });
  expect(seen).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']);
  expect(pausedWhilePending).toBeGreaterThan(0);
});

test('rejects on malformed XML after handing over earlier items', async () => {
  const xml = '<tv>' + prog(good, '<title>Before</title>') + `<programme ${good}><title>Cut`;
  const titles: string[] = [];
  await expect(parseXmltv(Readable.from([xml]), { channel() {}, programme: (p) => { titles.push(p.title); } })).rejects.toThrow();
  expect(titles).toEqual(['Before']);
  await expect(parseXmltv(Readable.from(['<tv>', '<a></b>']), { channel() {}, programme() {} })).rejects.toThrow();
});

test('rejects on source errors', async () => {
  const s = new Readable({ read() { this.destroy(new Error('boom')); } });
  await expect(parseXmltv(s, { channel() {}, programme() {} })).rejects.toThrow('boom');
});

test('streams 50,000 programmes', async () => {
  const t = (n: number) => new Date(n * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  function* gen() {
    yield '<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel>';
    for (let i = 0; i < 50_000; i++) {
      const s = 1_782_000_000 + i * 60;
      yield `<programme start="${t(s)}" stop="${t(s + 60)}" channel="a"><title>Show ${i}</title><desc>Description of show ${i}</desc></programme>\n`;
    }
    yield '</tv>';
  }
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  let n = 0;
  const counts = await parseXmltv(Readable.from(gen()), { channel() {}, programme() { n++; } });
  expect(counts).toEqual({ channels: 1, programmes: 50_000, skipped: 0 });
  expect(n).toBe(50_000);
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(process.memoryUsage().rss - rss0).toBeLessThan(100 * 1024 * 1024);
});
