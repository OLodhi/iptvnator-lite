import { pipeline, Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import { SaxesParser } from 'saxes';

export type XmltvChannel = { id: string; names: string[] };
export type XmltvProgramme = {
  channel: string; start: number; stop: number; title: string;
  subtitle: string | null; description: string | null; category: string | null;
};
export type XmltvHandlers = {
  channel(c: XmltvChannel): void | Promise<void>;
  programme(p: XmltvProgramme): void | Promise<void>;
};

const TIME_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?$/;

/** XMLTV time to epoch seconds. A missing offset means UTC. */
export function parseXmltvTime(s: string): number | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, sign, oh, om] = m;
  const ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(sec ?? 0));
  if (Number.isNaN(ms)) return null;
  const offset = sign ? (sign === '-' ? -1 : 1) * (+oh! * 3600 + +om! * 60) : 0;
  return ms / 1000 - offset;
}

/** Passes the source through, gunzipping it when it starts with the gzip magic bytes. No byte is lost. */
export function maybeGunzip(source: Readable): Readable {
  async function* sniff() {
    const it = source[Symbol.asyncIterator]();
    let head = Buffer.alloc(0);
    let done = false;
    while (head.length < 2 && !done) {
      const r = await it.next();
      if (r.done) done = true;
      else head = Buffer.concat([head, Buffer.from(r.value)]);
    }
    if (head.length === 0) return;
    async function* replay() {
      yield head;
      if (!done) for (;;) { const r = await it.next(); if (r.done) return; yield Buffer.from(r.value); }
    }
    if (head[0] === 0x1f && head[1] === 0x8b) {
      const gunzip = createGunzip();
      pipeline(Readable.from(replay(), { objectMode: false }), gunzip, () => {});
      yield* gunzip;
    } else {
      yield* replay();
    }
  }
  return Readable.from(sniff(), { objectMode: false });
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseXmltv(source: Readable, handlers: XmltvHandlers): Promise<{ channels: number; programmes: number; skipped: number }> {
  return new Promise((resolve, reject) => {
    const parser = new SaxesParser();
    const decoder = new StringDecoder('utf8');
    const counts = { channels: 0, programmes: 0, skipped: 0 };
    let settled = false;
    let pending: Promise<void>[] = [];

    // Per-element state; only one channel or programme is open at a time.
    let channel: { id: string; names: string[] } | null = null;
    let prog: { channel: string; start: string; stop: string; title: string | null; subtitle: string | null; description: string | null; category: string | null } | null = null;
    let field: 'title' | 'subtitle' | 'description' | 'category' | 'name' | null = null;
    let text = '';

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      source.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const hand = (r: void | Promise<void>) => { if (r) pending.push(r); };

    parser.on('error', fail);
    parser.on('opentag', (tag) => {
      const a = tag.attributes as Record<string, string>;
      if (tag.name === 'channel') channel = { id: (a.id ?? '').trim(), names: [] };
      else if (tag.name === 'programme') {
        prog = { channel: (a.channel ?? '').trim(), start: a.start ?? '', stop: a.stop ?? '', title: null, subtitle: null, description: null, category: null };
      } else if (channel && tag.name === 'display-name') field = 'name';
      else if (prog) {
        field = tag.name === 'title' ? 'title' : tag.name === 'sub-title' ? 'subtitle' : tag.name === 'desc' ? 'description' : tag.name === 'category' ? 'category' : null;
      }
      text = '';
    });
    const onText = (t: string) => { if (field) text += t; };
    parser.on('text', onText);
    parser.on('cdata', onText);
    parser.on('closetag', (tag) => {
      if (settled) return; // saxes keeps emitting after an error; nothing past it is trustworthy
      if (tag.name === 'channel') {
        const c = channel;
        channel = null;
        if (c && c.id) { counts.channels++; hand(handlers.channel(c)); }
      } else if (tag.name === 'programme') {
        const p = prog;
        prog = null;
        const start = p ? parseXmltvTime(p.start) : null;
        const stop = p && p.stop ? parseXmltvTime(p.stop) : null;
        if (!p || !p.channel || start === null || stop === null || stop <= start || !p.title) { counts.skipped++; return; }
        counts.programmes++;
        hand(handlers.programme({ channel: p.channel, start, stop, title: p.title, subtitle: p.subtitle || null, description: p.description || null, category: p.category || null }));
      } else if (field) {
        const v = clean(text);
        if (field === 'name') { if (v && channel) channel.names.push(v); }
        else if (prog && prog[field] === null) prog[field] = v;
        field = null;
      }
    });

    const feed = (chunk: string) => {
      try { parser.write(chunk); } catch (e) { fail(e); }
    };

    source.on('error', fail);
    source.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
      if (settled || pending.length === 0) return;
      const batch = pending;
      pending = [];
      source.pause();
      Promise.all(batch).then(() => { if (!settled) source.resume(); }, fail);
    });
    source.on('end', () => {
      if (settled) return;
      try { parser.write(decoder.end()); parser.close(); } catch (e) { fail(e); return; }
      const rest = pending;
      pending = [];
      Promise.all(rest).then(() => { if (!settled) { settled = true; resolve(counts); } }, fail);
    });
  });
}
