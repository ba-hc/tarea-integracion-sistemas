import type { IncomingMessage, ServerResponse } from 'node:http';

export type SimulatorMode = 'normal' | 'slow' | 'down' | 'decline';

export interface SimulatorConfig {
  mode: SimulatorMode;
  latencyMs: number;
  slowDelayMs: number;
}

export interface SimulatorStats {
  /** Llamadas a /v1 (cobros, consultas y reembolsos); excluye /health y /admin. */
  apiRequests: number;
  chargesApproved: number;
  chargesDeclined: number;
  chargeReplays: number;
  refunds: number;
  voids: number;
  refundReplays: number;
  rejectedWhileDown: number;
}

export interface Simulator {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): void;
  config(): SimulatorConfig;
  stats(): SimulatorStats;
}

export const MODES: readonly SimulatorMode[];
export function validateConfig(config: SimulatorConfig): SimulatorConfig;
export function configFromEnv(env?: Record<string, string | undefined>): SimulatorConfig;
export function createSimulator(config: SimulatorConfig): Simulator;
