import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  INVENTORY_SERVICE,
  type GetPartRequest,
  type GetPartResponse,
  type ListPartsResponse,
} from '../grpc/inventory.proto-types.js';
import { toProtoPart } from './part.mapper.js';
import { PartsService } from './parts.service.js';

/** RPCs de consulta de InventoryService. ReserveStock/ReleaseStock llegan en RS-202. */
@Controller()
export class PartsController {
  constructor(@Inject(PartsService) private readonly parts: PartsService) {}

  @GrpcMethod(INVENTORY_SERVICE, 'GetPart')
  async getPart(request: GetPartRequest): Promise<GetPartResponse> {
    const part = await this.parts.getPart(request.part_id);
    return { part: toProtoPart(part) };
  }

  @GrpcMethod(INVENTORY_SERVICE, 'ListParts')
  async listParts(): Promise<ListPartsResponse> {
    const parts = await this.parts.listParts();
    return { parts: parts.map(toProtoPart) };
  }
}
