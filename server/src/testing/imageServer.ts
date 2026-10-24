import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** A 1x1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);

/** A local image host: /logo.png, /page.html (not an image), /big.png (10 kB), /slow.png (never answers in time). */
export async function startImageServer() {
  const hits: { url: string; userAgent: string | undefined }[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? '', userAgent: req.headers['user-agent'] });
    if (req.url === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    } else if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    } else if (req.url === '/big.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.alloc(5_000));
      setTimeout(() => res.end(Buffer.alloc(5_000)), 20);
    } else if (req.url === '/slow.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(PNG);
      // never ends
    } else {
      res.writeHead(404).end();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
