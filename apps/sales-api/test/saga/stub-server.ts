import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface StubReply {
  status: number;
  body?: unknown;
  /** Retraso antes de responder, para simular un servicio lento. */
  delayMs?: number;
}

/** Servidor HTTP local en un puerto efímero que responde lo que dicte cada prueba. */
export class StubServer {
  readonly requests: RecordedRequest[] = [];
  reply: (request: RecordedRequest) => StubReply = () => ({ status: 500 });
  private server: Server | undefined;
  private readonly timers = new Set<NodeJS.Timeout>();

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const recorded: RecordedRequest = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    this.requests.push(recorded);
    const reply = this.reply(recorded);
    const send = () => {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    };
    if (!reply.delayMs) {
      send();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!response.destroyed) send();
    }, reply.delayMs);
    this.timers.add(timer);
  }
}

/** Una URL donde nadie escucha: la conexión se rechaza (ECONNREFUSED). */
export async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
