import type { FastifyPluginAsync } from 'fastify';
import type { AddProviderRequest, ApiError } from '@tv/shared';
import { ProviderError } from '../providers/errors.ts';
import type { ProviderService } from '../providers/service.ts';

const addSchema = {
  type: 'object',
  required: ['kind', 'serverUrl', 'username', 'password'],
  properties: {
    kind: { const: 'xtream' },
    name: { type: 'string' },
    serverUrl: { type: 'string', minLength: 1 },
    username: { type: 'string', minLength: 1 },
    password: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

export const providerRoutes = (providers: ProviderService): FastifyPluginAsync =>
  async (app) => {
    app.setErrorHandler((err: Error, _req, reply) => {
      if (err instanceof ProviderError) {
        const body: ApiError = { code: err.code, message: err.message };
        return reply.code(422).send(body);
      }
      if ((err as { validation?: unknown }).validation) {
        const body: ApiError = { code: 'VALIDATION', message: err.message };
        return reply.code(400).send(body);
      }
      throw err;
    });

    app.get('/providers', async () => providers.list());

    app.post<{ Body: AddProviderRequest }>('/providers', { schema: { body: addSchema } }, async (req, reply) => {
      const created = await providers.add(req.body);
      return reply.code(201).send(created);
    });
  };
