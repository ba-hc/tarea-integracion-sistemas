import { Inject, Injectable } from '@nestjs/common';
import { InvalidArgumentError, PartNotFoundError } from '../common/inventory-errors.js';
import { isUuid } from '../common/uuid.js';
import type { Part } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Consultas de sólo lectura sobre el catálogo de piezas. */
@Injectable()
export class PartsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getPart(partId: string): Promise<Part> {
    // Se valida antes de consultar: un id mal formado es un error del
    // llamador (INVALID_ARGUMENT), no una falla de base de datos (INTERNAL).
    if (!isUuid(partId)) {
      throw new InvalidArgumentError('part_id must be a UUID');
    }

    const part = await this.prisma.part.findUnique({ where: { id: partId } });
    if (!part) {
      throw new PartNotFoundError(partId);
    }
    return part;
  }

  /** Inventario completo: el catálogo es pequeño y el contrato v1 no pagina. */
  listParts(): Promise<Part[]> {
    return this.prisma.part.findMany({ orderBy: { sku: 'asc' } });
  }
}
