import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentsDatabase } from './database.js';
import type { Payment } from './generated/prisma/client.js';
import { GatewayClient, breakerOutcome, type ChargeResult, type RefundResult } from './gateway/gateway.client.js';
import { PaymentsError } from './http.js';
import { GatewayGuard, type RejectionReason } from './resilience/gateway-guard.js';

export interface PaymentView {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: Payment['status'];
}

export interface PaymentReply {
  readonly status: 200 | 201 | 202;
  readonly body: PaymentView;
}

const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  CIRCUIT_OPEN: 'Payment gateway circuit is open; no charge was made',
  BULKHEAD_FULL: 'Payment gateway concurrency limit reached; no charge was made',
};

function view(payment: Payment): PaymentView {
  return { orderId: payment.orderId, amountMinor: payment.amountMinor, currency: payment.currency, status: payment.status };
}

function chargeRejected(message: string): PaymentsError {
  return new PaymentsError(503, 'PAYMENT_CHARGE_REJECTED', message);
}

/**
 * Un cobro por venta (`orderId`). Las transiciones son actualizaciones
 * condicionales sobre el estado esperado, así que dos solicitudes simultáneas
 * para la misma venta no pueden pisarse. La pasarela es idempotente por
 * `charge-{orderId}`: repetir el envío nunca cobra dos veces.
 *
 * `gateway_attempts = 0` es la prueba de que la pasarela nunca vio el cobro.
 * Sólo en ese caso Pagos borra el registro y responde
 * `503 PAYMENT_CHARGE_REJECTED` (garantía de «no hubo cobro»).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');

  constructor(
    @Inject(PaymentsDatabase) private readonly db: PaymentsDatabase,
    @Inject(GatewayClient) private readonly gateway: GatewayClient,
    @Inject(GatewayGuard) private readonly guard: GatewayGuard,
  ) {}

  async get(orderId: string): Promise<PaymentView> {
    const payment = await this.find(orderId);
    if (!payment) throw new PaymentsError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    return view(payment);
  }

  async charge(orderId: string, amountMinor: number, currency: string, traceId: string): Promise<PaymentReply> {
    await this.db.payment.createMany({ data: { orderId, amountMinor, currency }, skipDuplicates: true });
    const payment = await this.find(orderId);
    if (!payment) throw chargeRejected('Charge was rejected before reaching the payment gateway');
    if (payment.amountMinor !== amountMinor || payment.currency !== currency) {
      throw new PaymentsError(409, 'PAYMENT_CONFLICT', 'A payment already exists for this order with a different amount or currency');
    }
    if (payment.status !== 'PENDING') return this.chargeReply(payment);
    return this.attemptCharge(payment, traceId);
  }

  async refund(orderId: string, traceId: string): Promise<PaymentReply> {
    const payment = await this.find(orderId);
    if (!payment) throw new PaymentsError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (payment.status === 'REFUNDED' || payment.status === 'DECLINED') return this.refundReply(payment);

    const admission = this.guard.admit();
    if (!admission.admitted) {
      this.logger.log('refund rejected before reaching the gateway', { reason: admission.reason, orderId, traceId });
      throw new PaymentsError(503, 'PAYMENT_REFUND_REJECTED', 'Refund was not attempted; retry later');
    }
    let result: RefundResult | undefined;
    try {
      const claimed = await this.db.payment.updateMany({
        where: { orderId, status: { in: ['PENDING', 'CHARGED', 'REFUND_PENDING'] } },
        data: { status: 'REFUND_PENDING' },
      });
      if (claimed.count === 0) return this.refundReply(await this.require(orderId));
      result = await this.gateway.refund(orderId, traceId);
    } finally {
      admission.release(result ? breakerOutcome(result) : 'ignored');
    }

    if (result.kind === 'refunded' || result.kind === 'voided') {
      await this.db.payment.updateMany({
        where: { orderId, status: 'REFUND_PENDING' },
        data: { status: 'REFUNDED', refundOutcome: result.kind === 'voided' ? 'VOIDED' : 'REFUNDED', lastErrorCode: null },
      });
    } else if (result.kind === 'not_refundable') {
      await this.db.payment.updateMany({ where: { orderId, status: 'REFUND_PENDING' }, data: { status: 'DECLINED' } });
    } else {
      await this.noteError(orderId, 'REFUND_PENDING', result.kind === 'uncertain' ? 'GATEWAY_REFUND_UNCERTAIN' : 'GATEWAY_UNAVAILABLE');
    }
    return this.refundReply(await this.require(orderId));
  }

  private async attemptCharge(payment: Payment, traceId: string): Promise<PaymentReply> {
    const { orderId } = payment;
    const admission = this.guard.admit();
    if (!admission.admitted) {
      this.logger.log('charge rejected before reaching the gateway', { reason: admission.reason, orderId, traceId });
      const { count } = await this.db.payment.deleteMany({ where: { orderId, status: 'PENDING', gatewayAttempts: 0 } });
      if (count === 1) throw chargeRejected(REJECTION_MESSAGES[admission.reason]);
      return this.currentChargeReply(orderId);
    }

    let result: ChargeResult | undefined;
    try {
      const claimed = await this.db.payment.updateMany({
        where: { orderId, status: 'PENDING' },
        data: { gatewayAttempts: { increment: 1 } },
      });
      if (claimed.count === 0) return this.currentChargeReply(orderId);
      result = await this.gateway.charge(orderId, payment.amountMinor, payment.currency, traceId);
    } finally {
      admission.release(result ? breakerOutcome(result) : 'ignored');
    }

    switch (result.kind) {
      case 'approved': {
        const { count } = await this.db.payment.updateMany({
          where: { orderId, status: 'PENDING' },
          data: { status: 'CHARGED', gatewayChargeId: result.chargeId, lastErrorCode: null },
        });
        if (count === 1) return { status: 201, body: { ...view(payment), status: 'CHARGED' } };
        break;
      }
      case 'declined':
        await this.db.payment.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'DECLINED', lastErrorCode: null } });
        break;
      case 'not_applied': {
        const { count } = await this.db.payment.deleteMany({ where: { orderId, status: 'PENDING', gatewayAttempts: 1 } });
        if (count === 1) throw chargeRejected('Payment gateway is unavailable; no charge was made');
        await this.noteError(orderId, 'PENDING', 'GATEWAY_UNAVAILABLE');
        break;
      }
      case 'uncertain':
        await this.noteError(orderId, 'PENDING', result.reason === 'timeout' ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNCERTAIN');
        break;
      case 'voided':
        break;
    }
    return this.currentChargeReply(orderId);
  }

  private async currentChargeReply(orderId: string): Promise<PaymentReply> {
    const payment = await this.find(orderId);
    if (!payment) throw chargeRejected('Charge was rejected before reaching the payment gateway');
    return this.chargeReply(payment);
  }

  private chargeReply(payment: Payment): PaymentReply {
    switch (payment.status) {
      case 'CHARGED':
        return { status: 200, body: view(payment) };
      case 'PENDING':
        return { status: 202, body: view(payment) };
      case 'DECLINED':
        throw new PaymentsError(422, 'PAYMENT_DECLINED', 'The payment gateway declined the charge');
      case 'REFUND_PENDING':
      case 'REFUNDED':
        throw new PaymentsError(409, 'PAYMENT_ALREADY_REFUNDED', 'The payment for this order was refunded and cannot be charged again');
    }
  }

  private refundReply(payment: Payment): PaymentReply {
    if (payment.status === 'REFUNDED') return { status: 200, body: view(payment) };
    if (payment.status === 'DECLINED') {
      throw new PaymentsError(409, 'PAYMENT_NOT_REFUNDABLE', 'The charge was declined; there is nothing to refund');
    }
    return { status: 202, body: view(payment) };
  }

  private async noteError(orderId: string, status: Payment['status'], code: string): Promise<void> {
    await this.db.payment.updateMany({ where: { orderId, status }, data: { lastErrorCode: code } });
  }

  private find(orderId: string): Promise<Payment | null> {
    return this.db.payment.findUnique({ where: { orderId } });
  }

  private async require(orderId: string): Promise<Payment> {
    const payment = await this.find(orderId);
    if (!payment) throw new Error('Payment disappeared during refund');
    return payment;
  }
}
