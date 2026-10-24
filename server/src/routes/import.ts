import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiError } from '@tv/shared';
import type { CurationService } from '../curation/service.ts';
import type { Db } from '../db/db.ts';
import { ImportError, importIptvnator } from '../import/iptvnator.ts';
import type { PersonalService } from '../personal/service.ts';
import type { ProviderService } from '../providers/service.ts';
import { currentUserId } from '../users.ts';

export const IMPORT_LIMIT = 512 * 1024 * 1024;

export const importRoutes = (deps: {
  db: Db;
  curation: CurationService;
  personal: PersonalService;
  providers: ProviderService;
  /** Where uploads are spooled; the OS temp directory if left out. */
  tmpDir?: string;
}): FastifyPluginAsync =>
  async (app) => {
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
      { bodyLimit: IMPORT_LIMIT, schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } } },
      async (req, reply) => {
        const providerId = req.params.id;
        if (!deps.providers.get(providerId)) {
          const body: ApiError = { code: 'NOT_FOUND', message: `Provider ${providerId} not found` };
          return reply.code(404).send(body);
        }
        const dir = fs.mkdtempSync(path.join(deps.tmpDir ?? os.tmpdir(), 'tv-import-'));
        try {
          const file = path.join(dir, 'iptvnator.db');
          let received = 0;
          // Fastify checks Content-Length up front; this covers a chunked body that never declares one.
          const limit = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              received += chunk.length;
              cb(received > IMPORT_LIMIT ? new Error('Import file too large') : null, chunk);
            },
          });
          await pipeline(req.body as NodeJS.ReadableStream, limit, fs.createWriteStream(file));
          return importIptvnator(deps, { file, providerId, userId: currentUserId(req) });
        } catch (err) {
          if (err instanceof ImportError) {
            const body: ApiError = { code: err.code, message: err.message };
            return reply.code(err.code === 'NOT_IPTVNATOR' ? 400 : 422).send(body);
          }
          throw err;
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  };
