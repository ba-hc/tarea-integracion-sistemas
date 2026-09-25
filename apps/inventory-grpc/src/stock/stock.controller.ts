import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  INVENTORY_SERVICE,
  type ReleaseStockRequest,
  type ReleaseStockResponse,
  type ReserveStockRequest,
  type ReserveStockResponse,
} from '../grpc/inventory.proto-types.js';
import { parseReleaseRequest, parseReserveRequest } from './stock-request.js';
import { toStockResponse } from './stock.mapper.js';
import { StockService } from './stock.service.js';

/** RPCs que mutan stock de InventoryService. */
@Controller()
export class StockController {
  constructor(@Inject(StockService) private readonly stock: StockService) {}

  @GrpcMethod(INVENTORY_SERVICE, 'ReserveStock')
  async reserveStock(request: ReserveStockRequest): Promise<ReserveStockResponse> {
    const result = await this.stock.reserve(parseReserveRequest(request));
    return toStockResponse(result);
  }

  @GrpcMethod(INVENTORY_SERVICE, 'ReleaseStock')
  async releaseStock(request: ReleaseStockRequest): Promise<ReleaseStockResponse> {
    const result = await this.stock.release(parseReleaseRequest(request));
    return toStockResponse(result);
  }
}
