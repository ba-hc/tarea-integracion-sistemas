import type { Role } from '../config/gateway-config.js';

export interface GatewayLogRecord {
  readonly gatewayRequestId: string;
  readonly upstreamTraceId?: string;
  readonly method: 'GET' | 'POST' | 'OTHER';
  readonly routeTemplate: string;
  readonly role: 'anonymous' | Role;
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode?: string;
}

export interface GatewayLoggerPort {
  log(record: GatewayLogRecord): void;
}

export class ConsoleGatewayLogger implements GatewayLoggerPort {
  log(record: GatewayLogRecord): void {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}
