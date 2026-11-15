import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { createBffApp } from '../src/app.js';
import type { BffConfig } from '../src/config/bff-config.js';
import type { BffLoggerPort, BffLogRecord } from '../src/logging/bff-logger.js';

export interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export type StubHandler = (request: StubRequest, response: ServerResponse) => void | Promise<void>;

export interface StubServer {
  readonly url: string;
  readonly requests: StubRequest[];
  setHandler(handler: StubHandler): void;
  close(): Promise<void>;
}

async function readAll(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function startStubServer(initialHandler: StubHandler): Promise<StubServer> {
  let handler = initialHandler;
  const requests: StubRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readAll(request);
    const record: StubRequest = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body,
    };
    requests.push(record);
    try {
      await handler(record, response);
    } catch {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader('Content-Type', 'application/json');
        response.end('{"code":"STUB_ERROR","message":"stub error","traceId":"00000000-0000-4000-8000-000000000000"}');
      } else {
        response.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setHandler(nextHandler: StubHandler): void {
      handler = nextHandler;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

export interface BffHandle {
  readonly app: INestApplication;
  readonly url: string;
  close(): Promise<void>;
}

export async function startBff(
  config: BffConfig,
  overrides: { logger?: BffLoggerPort } = {},
): Promise<BffHandle> {
  const app = await createBffApp(config, overrides);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

export async function request(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    redirect: 'manual',
  };
  if (options.headers !== undefined) init.headers = options.headers;
  if (options.body !== undefined) init.body = options.body;
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

export function rawRequest(baseUrl: string, requestText: string): Promise<string> {
  const url = new URL(baseUrl);
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.write(requestText));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

export interface TestConfigOptions {
  sourceTimeoutMs?: number;
  maxResponseBytes?: number;
}

export function testConfig(
  paymentsBaseUrl: string,
  dispatchBaseUrl: string,
  options: TestConfigOptions = {},
): BffConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    paymentsBaseUrl,
    dispatchBaseUrl,
    sourceTimeoutMs: options.sourceTimeoutMs ?? 300,
    maxResponseBytes: options.maxResponseBytes ?? 2_097_152,
  };
}

export function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function textResponse(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain',
): void {
  response.writeHead(status, { 'Content-Type': contentType });
  response.end(body);
}

export class MemoryLogger implements BffLoggerPort {
  readonly records: BffLogRecord[] = [];

  log(record: BffLogRecord): void {
    this.records.push(record);
  }
}

export function pathOf(url: string): string {
  return url.split('?', 1)[0] ?? url;
}
