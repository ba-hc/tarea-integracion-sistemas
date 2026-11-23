import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createSimulator,
  type Simulator,
  type SimulatorConfig,
} from '../../payment-gateway-sim/src/simulator.mjs';

/** La pasarela simulada real (apps/payment-gateway-sim) en un puerto efímero. */
export class GatewaySim {
  private simulator: Simulator | undefined;
  private server: Server | undefined;
  baseUrl = '';

  async start(config: Partial<SimulatorConfig> = {}): Promise<string> {
    this.simulator = createSimulator({ mode: 'normal', latencyMs: 0, slowDelayMs: 1_000, ...config });
    this.server = createServer((request, response) => void this.simulator!.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async configure(config: Partial<SimulatorConfig>): Promise<void> {
    const response = await fetch(`${this.baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!response.ok) throw new Error(`simulator rejected config: ${response.status}`);
  }

  stats() {
    return this.simulator!.stats();
  }

  async stop(): Promise<void> {
    this.simulator?.close();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/** Una URL donde nadie escucha: la conexión se rechaza sin enviar nada. */
export async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
