import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BffLogRecord, BffLoggerPort } from './logging/bff-logger.js';
import type { SummaryService } from './summary/summary.service.js';
import { BffService } from './bff.service.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

class RecordingLogger implements BffLoggerPort {
  readonly records: BffLogRecord[] = [];

  log(record: BffLogRecord): void {
    this.records.push(record);
  }
}

function fakeResponse(): ServerResponse & { body: string; headers: Record<string, string> } {
  const response = {
    statusCode: 200,
    headersSent: false,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    end(body: string): void {
      this.body = body;
      this.headersSent = true;
    },
  };
  return response as unknown as ServerResponse & { body: string; headers: Record<string, string> };
}

describe('BFF service unexpected failures', () => {
  it('returns a sanitized 500 with a consistent trace', async () => {
    const logger = new RecordingLogger();
    const summary = {
      summarize: async () => {
        throw new Error('database password leaked');
      },
    } as unknown as SummaryService;
    const service = new BffService(summary, logger);
    const request = {
      url: `/web/v1/orders/${ORDER_ID}/summary`,
      method: 'GET',
      rawHeaders: [],
      headers: {},
    } as unknown as IncomingMessage;
    const response = fakeResponse();

    await service.handle(request, response);

    expect(response.statusCode).toBe(500);
    expect(response.headers['x-trace-id']).toBeDefined();
    const body = JSON.parse(response.body) as { code: string; message: string; traceId: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.traceId).toBe(response.headers['x-trace-id']);
    expect(response.body).not.toContain('database password leaked');
    expect(logger.records.at(-1)).toMatchObject({
      route: '/web/v1/orders/:orderId/summary',
      status: 500,
      errorCode: 'INTERNAL_ERROR',
    });
  });
});
