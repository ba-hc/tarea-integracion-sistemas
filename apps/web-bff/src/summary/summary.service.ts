import { Inject, Injectable } from '@nestjs/common';
import { DISPATCH_SOURCE, PAYMENTS_SOURCE } from '../sources/tokens.js';
import type { DispatchSource, PaymentsSource } from '../sources/types.js';
import { summarize, type SummaryOutcome } from './summary-policy.js';

@Injectable()
export class SummaryService {
  constructor(
    @Inject(PAYMENTS_SOURCE) private readonly payments: PaymentsSource,
    @Inject(DISPATCH_SOURCE) private readonly dispatch: DispatchSource,
  ) {}

  async summarize(orderId: string, traceId: string): Promise<SummaryOutcome> {
    const [payment, dispatch] = await Promise.all([
      this.payments.get(orderId, traceId),
      this.dispatch.get(orderId, traceId),
    ]);
    return summarize(orderId, payment, dispatch);
  }
}
