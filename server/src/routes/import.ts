import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiError } from '@tv/shared';
import type { CurationService } from '../curation/service.ts';
import type { Db } from '../db/db.ts';
import { ImportError, importIptvnator } from '../import/iptvnator.ts';
import type { PersonalService } from '../personal/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { currentUserId } from '../users.ts';

export const IMPORT_LIMIT = 512 * 1024 * 1024;

class TooLarge extends Error {}

/**
 * Writes the body to `file` with backpressure, counting bytes as they arrive (a chunked body declares no length).
 * Past `max` it stops reading but leaves the request alone, so the 413 can still be sent; `pipeline` would destroy it.
 */
function spool(src: Readable, file: string, max: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let received = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      src.pause();
      src.off('data', onData);
      out.destroy();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > max) return fail(new TooLarge());
      if (!out.write(chunk)) {
        src.pause();
        out.once('drain', () => src.resume());
      }
    };
    src.on('data', onData);
    src.once('end', () => out.end());
    src.once('error', fail);
    out.once('error', fail);
    out.once('finish', () => {
      settled = true;
      resolve();
    });
  });
}

export const importRoutes = (deps: {
  db: Db;
  curation: CurationService;
  personal: PersonalService;
  providers: ProviderService;
  /** Where uploads are spooled; the OS temp directory if left out. */
  tmpDir?: string;
  /** The largest upload accepted, in bytes; 512 MB if left out. */
  maxImportBytes?: number;
}): FastifyPluginAsync =>
  async (app) => {
    const max = deps.maxImportBytes ?? IMPORT_LIMIT;
    const tooLarge = (): ApiError => ({ code: 'IMPORT_TOO_LARGE', message: `The import file is over ${max} bytes` });
    // The body is handed on as a stream so a 130 MB database never sits in memory.
    app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

    app.setErrorHandler((err: Error, _req, reply) => {
      if ((err as { validation?: unknown }).validation) {
        const body: ApiError = { code: 'VALIDATION', message: err.message };
        return reply.code(400).send(body);
      }
      throw err;
    });

    app.post<{ Params: { id: number } }>(
      '/providers/:id/import/iptvnator',
      { schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } } },
      async (req, reply) => {
        const providerId = req.params.id;
        if (!deps.providers.get(providerId)) {
          const body: ApiError = { code: 'NOT_FOUND', message: `Provider ${providerId} not found` };
          return reply.code(404).send(body);
        }
        // Fastify's bodyLimit only guards buffering parsers, not this streaming one, so the limit is enforced here.
        const declared = Number(req.headers['content-length']);
        if (declared > max) return reply.code(413).header('connection', 'close').send(tooLarge());
        const dir = fs.mkdtempSync(path.join(deps.tmpDir ?? os.tmpdir(), 'tv-import-'));
        try {
          const file = path.join(dir, 'iptvnator.db');
          await spool(req.body as Readable, file, max);
          return importIptvnator(deps, { file, providerId, userId: currentUserId(req) });
        } catch (err) {
          if (err instanceof TooLarge) return reply.code(413).header('connection', 'close').send(tooLarge());
          if (err instanceof ImportError) {
            const body: ApiError = { code: err.code, message: err.message };
            return reply.code(err.code === 'NOT_IPTVNATOR' ? 400 : 422).send(body);
          }
          throw err;
        } finally {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        }
      },
    );
  };
