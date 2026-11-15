import { Inject, Injectable } from '@nestjs/common';
import { GATEWAY_CONFIG, type GatewayConfig, type Role } from '../config/gateway-config.js';
import { validateJson } from '../http/body.js';
import { isJsonMediaType } from '../http/headers.js';
import {
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from '../http/errors.js';

export interface ProxyRequest {
  readonly target: 'sales' | 'bff';
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query: string;
  readonly body: Buffer;
  readonly contentType?: string;
  readonly idempotencyKey?: string;
  readonly accept?: string;
  readonly role?: Role;
  readonly gatewayRequestId: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface ProxyResult {
  readonly status: number;
  readonly body: Buffer;
  readonly contentType?: string;
  readonly location?: string;
  readonly idempotencyReplayed?: string;
  readonly traceId?: string;
}

async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new UpstreamUnavailableError();

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new UpstreamUnavailableError();
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The original failure is the useful one.
    }
    throw error;
  }
  return Buffer.concat(chunks);
}

@Injectable()
export class ProxyClient {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  async forward(request: ProxyRequest): Promise<ProxyResult> {
    const baseUrl = request.target === 'sales' ? this.config.salesBaseUrl : this.config.bffBaseUrl;
    const url = `${baseUrl}${request.path}${request.query ? `?${request.query}` : ''}`;

    const headers: Record<string, string> = {};
    if (request.accept !== undefined) headers.accept = request.accept;
    if (request.contentType !== undefined) headers['content-type'] = request.contentType;
    if (request.idempotencyKey !== undefined) headers['idempotency-key'] = request.idempotencyKey;
    if (request.target === 'sales' && request.role !== undefined) {
      headers['x-api-key'] = request.role === 'reader'
        ? this.config.salesApiKeyReader
        : this.config.salesApiKeyOperator;
    }
    if (request.target === 'bff') headers['x-trace-id'] = request.gatewayRequestId;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);

    try {
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      };
      if (request.body.length > 0) init.body = request.body as unknown as NonNullable<RequestInit['body']>;
      const response = await fetch(url, init);

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new UpstreamUnavailableError();
      }
      if (request.target === 'sales' && (response.status === 401 || response.status === 403)) {
        await response.body?.cancel();
        throw new UpstreamUnavailableError();
      }

      const contentType = response.headers.get('content-type') ?? undefined;
      if (!isJsonMediaType(contentType)) {
        await response.body?.cancel();
        throw new UpstreamUnavailableError();
      }

      const body = await readLimitedBody(response, request.maxResponseBytes);
      try {
        validateJson(body);
      } catch {
        throw new UpstreamUnavailableError();
      }

      const location = response.headers.get('location');
      const idempotencyReplayed = response.headers.get('idempotency-replayed');
      const traceId = response.headers.get('x-trace-id');
      return {
        status: response.status,
        body,
        ...(contentType !== undefined ? { contentType } : {}),
        ...(location !== null ? { location } : {}),
        ...(idempotencyReplayed !== null ? { idempotencyReplayed } : {}),
        ...(traceId !== null ? { traceId } : {}),
      };
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        throw new UpstreamTimeoutError();
      }
      if (error instanceof UpstreamTimeoutError || error instanceof UpstreamUnavailableError) {
        throw error;
      }
      throw new UpstreamUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }
}
