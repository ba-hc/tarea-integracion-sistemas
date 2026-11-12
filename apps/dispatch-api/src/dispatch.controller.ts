import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Res } from '@nestjs/common';
import { DispatchService, type DispatchItem } from './dispatch.service.js';
import { DispatchError, isUuid, type HttpResponse } from './http.js';

function orderIdParam(value: string): string {
  if (!isUuid(value)) throw new DispatchError(400, 'VALIDATION_ERROR', 'orderId must be a UUID');
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dispatchItems(body: unknown): DispatchItem[] {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Array.isArray(body.items) || body.items.length === 0) {
    throw new DispatchError(400, 'VALIDATION_ERROR', 'items must be a non-empty array');
  }
  const parts = new Set<string>();
  const items = body.items.map((item: unknown) => {
    if (!isRecord(item) || Object.keys(item).length !== 2 || !isUuid(item.partId)
      || typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new DispatchError(400, 'VALIDATION_ERROR', 'Each item needs a partId UUID and a positive integer quantity');
    }
    const partId = item.partId.toLowerCase();
    if (parts.has(partId)) throw new DispatchError(400, 'VALIDATION_ERROR', 'partId values must be unique');
    parts.add(partId);
    return { partId, quantity: item.quantity };
  });
  return items.sort((a, b) => a.partId.localeCompare(b.partId));
}

@Controller('internal/v1')
export class DispatchController {
  constructor(@Inject(DispatchService) private readonly dispatch: DispatchService) {}

  @Get('health')
  health() {
    return this.dispatch.health();
  }

  @Put('dispatches/:orderId')
  async create(@Param('orderId') orderId: string, @Body() body: unknown, @Res() response: HttpResponse): Promise<void> {
    const result = await this.dispatch.create(orderIdParam(orderId), dispatchItems(body));
    response.status(result.created ? 201 : 200).json(result.dispatch);
  }

  @Get('dispatches/:orderId')
  get(@Param('orderId') orderId: string) {
    return this.dispatch.get(orderIdParam(orderId));
  }

  @Post('dispatches/:orderId/cancel')
  @HttpCode(200)
  cancel(@Param('orderId') orderId: string) {
    return this.dispatch.cancel(orderIdParam(orderId));
  }
}
