import { Inject, Injectable } from '@nestjs/common';
import { BFF_CONFIG, type BffConfig } from '../config/bff-config.js';
import { isUuid } from '../http/uuid.js';
import { SourceHttpClient } from './source-http-client.js';
import type { DispatchItem, DispatchResult, DispatchSource } from './types.js';
import { isDispatchStatus, isRecord, parseJsonBody } from './validation.js';

@Injectable()
export class DispatchClient implements DispatchSource {
  private readonly http: SourceHttpClient;

  constructor(@Inject(BFF_CONFIG) config: BffConfig) {
    this.http = new SourceHttpClient(
      config.dispatchBaseUrl,
      config.sourceTimeoutMs,
      config.maxResponseBytes,
    );
  }

  async get(orderId: string, traceId: string): Promise<DispatchResult> {
    const response = await this.http.get(`/internal/v1/dispatches/${orderId}`, traceId);
    if (response.kind === 'timeout') return { availability: 'timeout' };
    if (response.kind === 'unavailable') return { availability: 'unavailable' };
    if (response.status === 404) return { availability: 'not_found' };
    if (response.status !== 200) return { availability: 'unavailable' };

    const parsed = parseJsonBody(response.body);
    if (!isRecord(parsed)) return { availability: 'unavailable' };

    const upstreamOrderId = parsed.orderId;
    if (
      typeof upstreamOrderId !== 'string'
      || !isUuid(upstreamOrderId)
      || upstreamOrderId.toLowerCase() !== orderId
    ) {
      return { availability: 'unavailable' };
    }

    const status = parsed.status;
    if (!isDispatchStatus(status)) return { availability: 'unavailable' };

    const rawItems = parsed.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return { availability: 'unavailable' };
    }

    const seen = new Set<string>();
    const items: DispatchItem[] = [];
    for (const rawItem of rawItems) {
      if (!isRecord(rawItem)) return { availability: 'unavailable' };
      const partId = rawItem.partId;
      if (typeof partId !== 'string' || !isUuid(partId)) return { availability: 'unavailable' };
      const normalizedPartId = partId.toLowerCase();
      if (seen.has(normalizedPartId)) return { availability: 'unavailable' };
      seen.add(normalizedPartId);

      const quantity = rawItem.quantity;
      if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) {
        return { availability: 'unavailable' };
      }
      items.push({ partId: normalizedPartId, quantity });
    }

    return { availability: 'available', data: { orderId, status, items } };
  }
}
