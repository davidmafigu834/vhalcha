import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { organisations } from '@vhalcha/database';
import { GatewayError } from '@vhalcha/types';
import {
  claimIdempotency,
  markIdempotency,
  completeChat,
  enforceBudget,
  prepareChat,
  rateHeaders,
  streamChat,
  type GatewayDeps,
} from './pipeline';
import { attachKnowledge, insufficientKnowledgeBody, INSUFFICIENT_KNOWLEDGE_MESSAGE, recordInsufficientKnowledge } from './knowledge';
import { enforceLiveGuard, inspectLiveGuard } from './guard-live';
import { applyOptimisedRoute } from './route';

export function buildServer(
  deps: GatewayDeps,
  options?: { bodyLimit?: number; allowedOrigins?: string[] },
): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: options?.bodyLimit ?? 1_000_000,
  });
  const origins = options?.allowedOrigins?.filter(Boolean) ?? [];

  app.register(helmet, {
    contentSecurityPolicy: false,
    global: true,
  });
  app.register(cors, {
    origin: origins.length > 0 ? origins : false,
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await deps.db.select({ id: organisations.id }).from(organisations).limit(1);
      const redisOk = await deps.redis.ping();
      if (!redisOk) {
        throw new Error('redis');
      }
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const prepared = await prepareChat(deps, request);
    const claim = await claimIdempotency(deps, prepared);
    if (claim.kind === 'completed') {
      throw new GatewayError(
        'idempotent_request_already_completed',
        'This idempotency key has already completed.',
        {},
        claim.requestId,
      );
    }
    if (claim.kind === 'conflict') {
      throw new GatewayError(
        'idempotency_conflict',
        'This idempotency key does not match the original request or is already in progress.',
      );
    }
    try {
      await attachKnowledge(deps, prepared);
    } catch (error) {
      await markIdempotency(deps, prepared, 'retryable_failed');
      throw error;
    }
    if (prepared.knowledge?.insufficient) {
      await recordInsufficientKnowledge(deps, prepared);
      await markIdempotency(deps, prepared, 'completed');
      if (prepared.body.stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'x-vhalcha-request-id': prepared.requestId,
        });
        reply.raw.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: INSUFFICIENT_KNOWLEDGE_MESSAGE } }] })}\n\n`,
        );
        reply.raw.write(
          `data: ${JSON.stringify({ vhalcha: { knowledge: { used: false, evidence: 'insufficient', citations: [] } } })}\n\n`,
        );
        reply.raw.end('data: [DONE]\n\n');
        return reply;
      }
      return reply
        .header('x-vhalcha-request-id', prepared.requestId)
        .send(insufficientKnowledgeBody(prepared.requestId));
    }
    try {
      await inspectLiveGuard(deps, prepared);
      await applyOptimisedRoute(deps, prepared);
      await enforceLiveGuard(deps, prepared);
      await enforceBudget(deps, prepared);
    } catch (error) {
      const retryable =
        error instanceof GatewayError &&
        (error.code === 'provider_unavailable' || error.code === 'control_plane_unavailable');
      await markIdempotency(deps, prepared, retryable ? 'retryable_failed' : 'terminal_failed');
      throw error;
    }
    if (prepared.body.stream) {
      reply.hijack();
      try {
        await streamChat(deps, prepared, reply.raw);
      } catch (error) {
        console.error(
          `stream failed after accept — ${error instanceof Error ? error.message.slice(0, 300) : 'Error'}`,
        );
        if (!reply.raw.headersSent) {
          const gatewayError =
            error instanceof GatewayError
              ? error
              : new GatewayError('internal_error', 'The request could not be completed.');
          reply.raw.writeHead(gatewayError.statusCode, {
            'content-type': 'application/json; charset=utf-8',
          });
          reply.raw.end(JSON.stringify(gatewayError.toJSON()));
        }
      }
      return reply;
    }
    const body = await completeChat(deps, prepared);
    return reply
      .headers(rateHeaders(prepared.rateLimit))
      .header('x-vhalcha-request-id', prepared.requestId)
      .header('x-idempotency-supported', prepared.idempotencyKey ? 'true' : 'false')
      .send(body);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof GatewayError) {
      return reply.code(error.statusCode).headers(error.headers).send(error.toJSON());
    }
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'The request body is invalid.' },
      });
    }
    deps.logger.error(
      { name: error instanceof Error ? error.name : 'Error', request_id: request.id },
      'unhandled gateway error',
    );
    deps.tracker?.captureException(error);
    deps.metrics.increment('errors');
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        message:
          process.env.VITEST && error instanceof Error
            ? error.message.slice(0, 300)
            : 'The request could not be completed.',
      },
    });
  });

  return app;
}
