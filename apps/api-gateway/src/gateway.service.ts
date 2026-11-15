import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { JwtVerifier } from './auth/jwt-verifier.js';
import { parseBearer } from './auth/bearer.js';
import {
  GATEWAY_CLOCK,
  GATEWAY_CONFIG,
  GATEWAY_LOGGER,
  type GatewayConfig,
  type Role,
} from './config/gateway-config.js';
import { readRequestBody, validateJson } from './http/body.js';
import {
  ForbiddenError,
  GatewayHttpError,
  InternalError,
  InvalidBodyError,
  InvalidTokenError,
  MethodNotAllowedError,
  RateLimitError,
  RouteNotFoundError,
} from './http/errors.js';
import {
  combinedHeader,
  hasRequestBody,
  isJsonMediaType,
  rawHeaderValues,
  singleHeader,
} from './http/headers.js';
import { parseRequestTarget } from './http/request-target.js';
import { sendError, sendJson, sendProxyResult } from './http/respond.js';
import { matchRoute } from './http/route.js';
import { isUuid } from './http/uuid.js';
import {
  type GatewayLoggerPort,
  type GatewayLogRecord,
} from './logging/gateway-logger.js';
import { ProxyClient } from './proxy/proxy-client.js';
import { RateLimiter } from './rate-limit/rate-limiter.js';

@Injectable()
export class GatewayService {
  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @Inject(GATEWAY_CLOCK) private readonly clock: () => number,
    private readonly jwt: JwtVerifier,
    private readonly limiter: RateLimiter,
    private readonly proxy: ProxyClient,
    @Inject(GATEWAY_LOGGER) private readonly logger: GatewayLoggerPort,
  ) {}

  handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startedAt = this.clock();
    const gatewayRequestId = randomUUID();
    const method = request.method === 'GET' || request.method === 'POST' ? request.method : 'OTHER';
    let routeTemplate = 'unmatched';
    let role: Role | undefined;
    let status = 500;
    let upstreamTraceId: string | undefined;
    let errorCode: string | undefined;

    try {
      const target = parseRequestTarget(request.url);
      if (request.method === 'GET' && hasRequestBody(request)) throw new InvalidBodyError();

      if (request.method === 'GET' && target.path === '/health') {
        routeTemplate = '/health';
        status = 200;
        sendJson(response, 200, { status: 'ok', service: 'gateway' }, gatewayRequestId);
        return;
      }

      if (request.method === 'GET' && target.path === '/v1/health') {
        routeTemplate = '/v1/health';
        const accept = combinedHeader(request, 'accept');
        const result = await this.proxy.forward({
          target: 'sales',
          method: 'GET',
          path: target.path,
          query: target.query,
          body: Buffer.alloc(0),
          gatewayRequestId,
          timeoutMs: this.config.salesTimeoutMs,
          maxResponseBytes: this.config.maxResponseBytes,
          ...(accept !== undefined ? { accept } : {}),
        });
        status = result.status;
        if (result.traceId !== undefined) upstreamTraceId = result.traceId;
        sendProxyResult(response, result);
        return;
      }

      const authorizationValues = rawHeaderValues(request, 'authorization');
      if (authorizationValues.length !== 1) throw new InvalidTokenError();
      const token = parseBearer(authorizationValues[0]);
      if (token === null) throw new InvalidTokenError();
      const identity = await this.jwt.verify(token);
      role = identity.role;

      const match = matchRoute(request.method ?? '', target.path);
      if (!match.pathMatched) throw new RouteNotFoundError();
      if (match.route === undefined) throw new MethodNotAllowedError();
      const route = match.route;
      routeTemplate = route.template;

      if (route.role === 'operator' && role !== 'operator') throw new ForbiddenError();

      const rate = this.limiter.check(identity.sub);
      if (!rate.allowed) throw new RateLimitError(rate.retryAfterSeconds ?? 1);

      let body: Buffer = Buffer.alloc(0);
      let contentType: string | undefined;
      if (route.body === 'json') {
        if (!hasRequestBody(request)) throw new InvalidBodyError();
        contentType = singleHeader(request, 'content-type');
        if (!isJsonMediaType(contentType)) throw new InvalidBodyError();
        body = await readRequestBody(request, this.config.maxRequestBytes);
        validateJson(body);
      } else if (hasRequestBody(request)) {
        throw new InvalidBodyError();
      }

      if (route.target === 'local') {
        routeTemplate = route.template;
        status = 200;
        sendJson(response, 200, { status: 'ok', service: 'gateway' }, gatewayRequestId);
        return;
      }

      const idempotencyKey = singleHeader(request, 'idempotency-key');
      const accept = combinedHeader(request, 'accept');
      const result = await this.proxy.forward({
        target: route.target,
        method: route.method,
        path: target.path,
        query: target.query,
        body,
        role,
        gatewayRequestId,
        timeoutMs: route.target === 'sales' ? this.config.salesTimeoutMs : this.config.bffTimeoutMs,
        maxResponseBytes: this.config.maxResponseBytes,
        ...(contentType !== undefined ? { contentType } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(accept !== undefined ? { accept } : {}),
      });
      status = result.status;
      if (result.traceId !== undefined) upstreamTraceId = result.traceId;
      sendProxyResult(response, result);
    } catch (error) {
      const httpError = error instanceof GatewayHttpError ? error : new InternalError();
      status = httpError.status;
      errorCode = httpError.code;
      try {
        if (!response.headersSent && hasRequestBody(request)) {
          response.setHeader('Connection', 'close');
        }
        sendError(response, httpError, gatewayRequestId);
      } catch {
        // The client may have disconnected; never surface the internal error.
      }
    } finally {
      const record: GatewayLogRecord = {
        gatewayRequestId,
        method,
        routeTemplate,
        role: role ?? 'anonymous',
        status,
        durationMs: Math.max(0, Math.round((this.clock() - startedAt) * 10) / 10),
        ...(upstreamTraceId !== undefined && isUuid(upstreamTraceId) ? { upstreamTraceId } : {}),
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
      try {
        this.logger.log(record);
      } catch {
        // Logging must not change the response or expose internals.
      }
    }
  };
}
