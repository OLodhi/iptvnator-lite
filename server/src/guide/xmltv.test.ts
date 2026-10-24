import { PassThrough, Readable } from 'node:stream';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('resolves only after slow handlers finish when EOF is already buffered', async () => {
  const source = new PassThrough();
  source.end(`<tv>${prog(good, '<title>A</title>')}${prog(good, '<title>B</title>')}</tv>`);
  const done: string[] = [];
  const counts = await parseXmltv(source, { channel() {}, programme: async (p) => { await sleep(50); done.push(p.title); } });
  expect(done).toEqual(['A', 'B']);
  expect(counts.programmes).toBe(2);
});

test('rejects when the last handler rejects', async () => {
  const source = new PassThrough();
  source.end(`<tv>${prog(good, '<title>A</title>')}${prog(good, '<title>B</title>')}</tv>`);
  await expect(parseXmltv(source, {
    channel() {},
    programme: async (p) => { await sleep(10); if (p.title === 'B') throw new Error('last failed'); },
  })).rejects.toThrow('last failed');
});

test('runs handlers strictly one at a time in document order', async () => {
  const xml = `<tv>${Array.from({ length: 40 }, (_, i) => prog(good, `<title>P${i}</title>`)).join('')}</tv>`;
  let active = 0;
  let maxActive = 0;
  const seen: string[] = [];
  await parseXmltv(Readable.from([xml]), {
    channel() {},
    programme: async (p) => { active++; maxActive = Math.max(maxActive, active); await sleep(1); seen.push(p.title); active--; },
  });
  expect(maxActive).toBe(1);
  expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => `P${i}`));
});

test('a late rejection after a saxes error is not unhandled', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const xml = `<tv>${prog(good, '<title>A</title>')}<a></b>`;
    await expect(parseXmltv(Readable.from([xml]), {
      channel() {},
      programme: async () => { await sleep(20); throw new Error('late'); },
    })).rejects.toThrow();
    await sleep(60);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('releases the source passed to maybeGunzip after a handler error', async () => {
  const raw = new Readable({ read() {} });
  raw.push(`<tv>${prog(good, '<title>A</title>')}`);
  await expect(parseXmltv(maybeGunzip(raw), { channel() {}, programme() { throw new Error('handler'); } })).rejects.toThrow('handler');
  for (let i = 0; i < 40 && !raw.destroyed; i++) await sleep(10);
  expect(raw.destroyed).toBe(true);
});

test('rejects when the source closes without end', async () => {
  const s = new Readable({ read() {} });
  s.push('<tv>');
  setTimeout(() => s.destroy(), 10);
  await expect(parseXmltv(s, { channel() {}, programme() {} })).rejects.toThrow(/closed/);
});

test('decodes a multi-byte character split across chunks', async () => {
  const buf = Buffer.from(wrap(prog(good, '<title>ITV 1 ᴴᴰ</title>')));
  const cut = buf.indexOf(Buffer.from('ᴴ')) + 1;
  const r = await collect(Readable.from([buf.subarray(0, cut), buf.subarray(cut)], { objectMode: false }));
  expect(r.programmes[0]!.title).toBe('ITV 1 ᴴᴰ');
});

test('nested credits, icon and episode-num do not corrupt fields', async () => {
  const xml = wrap(prog(good, '<title>Real</title><credits><actor>Bob</actor><director>Al</director></credits>'
    + '<icon src="x"/><episode-num system="onscreen">S1E2</episode-num><desc>Plot</desc><sub-title/><sub-title>Sub</sub-title>'));
  const r = await collect(Readable.from([xml]));
  expect(r.programmes[0]).toMatchObject({ title: 'Real', description: 'Plot', subtitle: 'Sub', category: null });
});

test('an empty first title does not block a later real one', async () => {
  const r = await collect(Readable.from([wrap(prog(good, '<title></title><title>Real</title>'))]));
  expect(r.programmes.map((p) => p.title)).toEqual(['Real']);
});

test('negative, invalid and out-of-range times', () => {
  expect(parseXmltvTime('20260701130000 -0500')).toBe(Z);
  expect(parseXmltvTime('20260701190000 +9999')).toBeNull();
  expect(parseXmltvTime('20261301190000')).toBeNull();
  expect(parseXmltvTime('20260701250000')).toBeNull();
  expect(parseXmltvTime('20260701196000')).toBeNull();
  expect(parseXmltvTime('20260701190000 +1400')).toBe(Z - 13 * 3600);
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
