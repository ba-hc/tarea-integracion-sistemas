import type { SourceAvailability } from '../sources/types.js';

export interface BffLogRecord {
  readonly traceId: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly payment?: SourceAvailability;
  readonly dispatch?: SourceAvailability;
  readonly errorCode?: string;
}

export interface BffLoggerPort {
  log(record: BffLogRecord): void;
}

export class ConsoleBffLogger implements BffLoggerPort {
  log(record: BffLogRecord): void {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}
