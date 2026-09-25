import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { OrderCreateDto, OrderListQueryDto } from './order.dto.js';
import { OrdersService } from './orders.service.js';
import type { OrderView } from './order.mapper.js';

interface TraceRequest {
  traceId: string;
}
interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

@Controller('v1/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  async create(
    @Body() body: OrderCreateDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: TraceRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ): Promise<OrderView> {
    const result = await this.orders.create(body, idempotencyKey, request.traceId);
    response.setHeader('Location', `/v1/orders/${result.order.id}`);
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.order;
  }

  @Get()
  list(@Query() query: OrderListQueryDto): Promise<{ page: number; pageSize: number; total: number; items: OrderView[] }> {
    return this.orders.list(query);
  }

  @Get(':orderId')
  get(@Param('orderId', new ParseUUIDPipe()) orderId: string): Promise<OrderView> {
    return this.orders.get(orderId);
  }

  @Post(':orderId/cancel')
  @HttpCode(200)
  cancel(
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Req() request: TraceRequest,
  ): Promise<OrderView> {
    return this.orders.cancel(orderId, request.traceId);
  }
}