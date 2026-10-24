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

/** XMLTV time to epoch seconds. A missing offset means UTC. Out-of-range fields give null. */
export function parseXmltvTime(s: string): number | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, sign, oh, om] = m;
  const month = +mo!, day = +d!, hour = +h!, minute = +mi!, second = +(sec ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (sign) {
    if (+om! > 59) return null;
    const abs = +oh! * 3600 + +om! * 60;
    if (abs > 14 * 3600) return null;
    offset = sign === '-' ? -abs : abs;
  }
  return Date.UTC(+y!, month - 1, day, hour, minute, second) / 1000 - offset;
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
  const out = Readable.from(sniff(), { objectMode: false });
  // Whoever destroys or finishes the wrapper releases the underlying (provider) stream too.
  // Readable.from's own teardown waits on the pending read, which can be the stalled provider, so hook _destroy first.
  const teardown = out._destroy.bind(out);
  out._destroy = (err, cb) => { source.destroy(); teardown(err, cb); };
  return out;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

type Field = 'title' | 'subtitle' | 'description' | 'category' | 'name';
const FIELD_OF: Record<string, Field> = { title: 'title', 'sub-title': 'subtitle', desc: 'description', category: 'category' };

/**
 * Streams XMLTV from `source`. Handlers run strictly one at a time, in document order; the source is paused
 * while they run. Resolves only once every handler has settled.
 */
export function parseXmltv(source: Readable, handlers: XmltvHandlers): Promise<{ channels: number; programmes: number; skipped: number }> {
  return new Promise((resolve, reject) => {
    const parser = new SaxesParser();
    const decoder = new StringDecoder('utf8');
    const counts = { channels: 0, programmes: 0, skipped: 0 };
    let settled = false;
    let ended = false;
    const queue: Array<() => void | Promise<void>> = [];
    let tail: Promise<void> = Promise.resolve();

    // Per-element state; only one channel or programme is open at a time.
    let channel: XmltvChannel | null = null;
    let prog: { channel: string; start: string; stop: string; title: string | null; subtitle: string | null; description: string | null; category: string | null } | null = null;
    let depth = 0;
    let ownerDepth = 0;
    let field: Field | null = null;
    let text = '';

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      queue.length = 0;
      source.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    parser.on('error', fail);
    parser.on('opentag', (tag) => {
      depth++;
      const a = tag.attributes as Record<string, string>;
      if (tag.name === 'channel') {
        channel = { id: (a.id ?? '').trim(), names: [] };
        ownerDepth = depth;
      } else if (tag.name === 'programme') {
        prog = { channel: (a.channel ?? '').trim(), start: a.start ?? '', stop: a.stop ?? '', title: null, subtitle: null, description: null, category: null };
        ownerDepth = depth;
      } else if (depth === ownerDepth + 1) {
        if (channel && tag.name === 'display-name') field = 'name';
        else if (prog) field = FIELD_OF[tag.name] ?? null;
        text = '';
      }
    });
    const onText = (t: string) => { if (field) text += t; };
    parser.on('text', onText);
    parser.on('cdata', onText);
    parser.on('closetag', (tag) => {
      const closing = depth--;
      if (settled) return; // saxes keeps emitting after an error; nothing past it is trustworthy
      if (tag.name === 'channel') {
        const c = channel;
        channel = null;
        if (c && c.id) { counts.channels++; queue.push(() => handlers.channel(c)); }
      } else if (tag.name === 'programme') {
        const p = prog;
        prog = null;
        const start = p ? parseXmltvTime(p.start) : null;
        const stop = p && p.stop ? parseXmltvTime(p.stop) : null;
        if (!p || !p.channel || start === null || stop === null || stop <= start || !p.title) { counts.skipped++; return; }
        counts.programmes++;
        const item: XmltvProgramme = { channel: p.channel, start, stop, title: p.title, subtitle: p.subtitle, description: p.description, category: p.category };
        queue.push(() => handlers.programme(item));
      } else if (field && closing === ownerDepth + 1) {
        const v = clean(text);
        if (v) {
          if (field === 'name') channel?.names.push(v);
          else if (prog && prog[field] === null) prog[field] = v;
        }
        field = null;
      }
    });

    // Runs the queued handlers one at a time. A rejection or throw fails the parse.
    const drain = async () => {
      while (queue.length && !settled) {
        const r = queue.shift()!();
        if (r) await r;
      }
    };
    const feed = (chunk: string) => {
      try { parser.write(chunk); } catch (e) { fail(e); }
    };

    source.on('error', fail);
    source.on('close', () => { if (!ended) fail(new Error('XMLTV source closed before the end')); });
    source.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
      if (settled || queue.length === 0) return;
      source.pause();
      tail = tail.then(drain).then(() => { if (!settled) source.resume(); }).catch(fail);
    });
    source.on('end', () => {
      ended = true;
      tail = tail.then(() => {
        if (settled) return;
        try { parser.write(decoder.end()); parser.close(); } catch (e) { fail(e); return; }
        return drain();
      }).then(() => { if (!settled) { settled = true; resolve(counts); } }).catch(fail);
    });
  });
}
