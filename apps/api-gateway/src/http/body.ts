import type { IncomingMessage } from 'node:http';
import { PayloadTooLargeError, InvalidBodyError } from './errors.js';

export async function readRequestBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new InvalidBodyError();
    if (parsed > limit) throw new PayloadTooLargeError();
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limit) {
        request.pause();
        fail(new PayloadTooLargeError());
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (): void => fail(new InvalidBodyError());
    const onAborted = (): void => fail(new InvalidBodyError());

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

export function validateJson(body: Buffer): void {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    JSON.parse(text);
  } catch {
    throw new InvalidBodyError();
  }
}
