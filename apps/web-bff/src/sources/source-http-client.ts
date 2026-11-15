import { isJsonMediaType } from '../http/headers.js';

export type SourceHttpResponse =
  | { readonly kind: 'response'; readonly status: number; readonly body: Buffer }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unavailable' };

class SourceUnavailableError extends Error {}

function discardBody(response: Response): void {
  const body = response.body;
  if (body === null) return;
  void body.cancel().catch(() => undefined);
}

async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new SourceUnavailableError();

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
        throw new SourceUnavailableError();
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

export class SourceHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes: number,
  ) {}

  async get(path: string, traceId: string): Promise<SourceHttpResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-trace-id': traceId,
        },
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status !== 200) {
        discardBody(response);
        return { kind: 'response', status: response.status, body: Buffer.alloc(0) };
      }

      const contentType = response.headers.get('content-type') ?? undefined;
      if (!isJsonMediaType(contentType)) {
        discardBody(response);
        return { kind: 'unavailable' };
      }

      const body = await readLimitedBody(response, this.maxResponseBytes);
      return { kind: 'response', status: response.status, body };
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        return { kind: 'timeout' };
      }
      if (error instanceof SourceUnavailableError) return { kind: 'unavailable' };
      return { kind: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }
}
