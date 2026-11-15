import { Inject, Injectable } from '@nestjs/common';
import { BFF_CONFIG, type BffConfig } from '../config/bff-config.js';
import { isUuid } from '../http/uuid.js';
import { SourceHttpClient } from './source-http-client.js';
import type { PaymentResult, PaymentsSource } from './types.js';
import { isPaymentStatus, isRecord, parseJsonBody } from './validation.js';

@Injectable()
export class PaymentsClient implements PaymentsSource {
  private readonly http: SourceHttpClient;

  constructor(@Inject(BFF_CONFIG) config: BffConfig) {
    this.http = new SourceHttpClient(
      config.paymentsBaseUrl,
      config.sourceTimeoutMs,
      config.maxResponseBytes,
    );
  }

  async get(orderId: string, traceId: string): Promise<PaymentResult> {
    const response = await this.http.get(`/internal/v1/payments/${orderId}`, traceId);
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
    if (!isPaymentStatus(status)) return { availability: 'unavailable' };

    return { availability: 'available', data: { orderId, status } };
  }
}
