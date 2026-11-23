import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { PaymentsConfig } from './config.js';
import { PaymentsError, isUuid, type HttpResponse, type TraceRequest } from './http.js';
import { PaymentsReconciler } from './payments.reconciler.js';
import { PaymentsDatabase } from './database.js';
import { PaymentsService, type PaymentReply } from './payments.service.js';
import { GatewayGuard } from './resilience/gateway-guard.js';
import { PAYMENTS_CONFIG } from './tokens.js';

const MAX_AMOUNT_MINOR = 2_147_483_647;

function orderIdParam(value: string): string {
  if (!isUuid(value)) throw new PaymentsError(400, 'VALIDATION_ERROR', 'orderId must be a UUID');
  return value.toLowerCase();
}

function chargeBody(body: unknown): { amountMinor: number; currency: string } {
  const value = body as Record<string, unknown> | null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'amountMinor,currency'
    || typeof value.amountMinor !== 'number' || !Number.isSafeInteger(value.amountMinor)
    || value.amountMinor < 1 || value.amountMinor > MAX_AMOUNT_MINOR
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) {
    throw new PaymentsError(400, 'VALIDATION_ERROR', 'Body must be { amountMinor: positive integer, currency: ISO 4217 code }');
  }
  return { amountMinor: value.amountMinor, currency: value.currency };
}

function send(response: HttpResponse, reply: PaymentReply): void {
  response.status(reply.status).json(reply.body);
}

@Controller('internal/v1')
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(GatewayGuard) private readonly guard: GatewayGuard,
    @Inject(PaymentsReconciler) private readonly reconciler: PaymentsReconciler,
    @Inject(PaymentsDatabase) private readonly db: PaymentsDatabase,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
  ) {}

  @Get('health')
  async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok', service: 'payments-api' };
  }

  /** Estado de las protecciones hacia la pasarela, para el experimento y la demo. */
  @Get('resilience')
  resilience() {
    return {
      gateway: { timeoutMs: this.config.gateway.timeoutMs },
      ...this.guard.snapshot(),
      reconciler: this.reconciler.snapshot(),
    };
  }

  @Put('payments/:orderId')
  async charge(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Req() request: TraceRequest,
    @Res() response: HttpResponse,
  ): Promise<void> {
    const { amountMinor, currency } = chargeBody(body);
    send(response, await this.payments.charge(orderIdParam(orderId), amountMinor, currency, request.traceId ?? ''));
  }

  @Get('payments/:orderId')
  get(@Param('orderId') orderId: string) {
    return this.payments.get(orderIdParam(orderId));
  }

  @Post('payments/:orderId/refund')
  @HttpCode(200)
  async refund(@Param('orderId') orderId: string, @Req() request: TraceRequest, @Res() response: HttpResponse): Promise<void> {
    send(response, await this.payments.refund(orderIdParam(orderId), request.traceId ?? ''));
  }
}
