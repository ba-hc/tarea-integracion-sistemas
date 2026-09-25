import { Inject, Injectable } from '@nestjs/common';
import {
  InsufficientStockError,
  OrderIdConflictError,
  PartsNotFoundError,
  ReservationAlreadyReleasedError,
  ReservationNotFoundError,
} from '../common/inventory-errors.js';
import { Prisma, type StockOperation, type StockOperationItem } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requestFingerprint, type ReserveCommand } from './stock-request.js';

export interface StockMutation {
  partId: string;
  partSku: string;
  partName: string;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
}

export interface StockOperationResult {
  orderId: string;
  items: StockMutation[];
  processedAt: Date;
  replayed: boolean;
}

interface LockedPart {
  id: string;
  sku: string;
  name: string;
  stockAvailable: number;
}

type OperationWithItems = StockOperation & { items: StockOperationItem[] };
type Tx = Prisma.TransactionClient;

const INCLUDE_ITEMS = { items: { orderBy: { lineNumber: 'asc' } } } as const;

// READ COMMITTED + bloqueos explícitos: cada sentencia ve lo último
// confirmado y los FOR UPDATE serializan sólo a quienes tocan las mismas
// piezas. maxWait cubre la espera por una conexión del pool bajo carga.
const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 10_000,
};

/**
 * Serializa las llamadas con el mismo order_id hasta el fin de la transacción.
 * Sin esto, dos ReserveStock idénticos simultáneos no verían la operación del
 * otro: el segundo fallaría por la clave primaria (INTERNAL) en vez de
 * devolver el replay.
 */
async function lockOrder(tx: Tx, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orderId}, 0))`;
}

/**
 * Bloquea las filas de las piezas hasta el fin de la transacción. El orden por
 * id hace que dos órdenes con piezas en común pidan los bloqueos en el mismo
 * orden, lo que evita deadlocks.
 */
function lockParts(tx: Tx, partIds: string[]): Promise<LockedPart[]> {
  return tx.$queryRaw<LockedPart[]>`
    SELECT id::text AS id, sku, name, stock_available AS "stockAvailable"
    FROM parts
    WHERE id = ANY(${partIds}::uuid[])
    ORDER BY id
    FOR UPDATE`;
}

function toReserveResult(operation: OperationWithItems, replayed: boolean): StockOperationResult {
  return {
    orderId: operation.orderId,
    processedAt: operation.reservedAt,
    replayed,
    items: operation.items.map((item) => ({
      partId: item.partId,
      partSku: item.partSku,
      partName: item.partName,
      quantity: item.quantity,
      stockBefore: item.reservedStockBefore,
      stockAfter: item.reservedStockAfter,
    })),
  };
}

function toReleaseResult(operation: OperationWithItems, replayed: boolean): StockOperationResult {
  if (operation.releasedAt === null) {
    throw new Error(`operation ${operation.orderId} is not released`);
  }
  return {
    orderId: operation.orderId,
    processedAt: operation.releasedAt,
    replayed,
    items: operation.items.map((item) => {
      if (item.releasedStockBefore === null || item.releasedStockAfter === null) {
        throw new Error(`item ${item.id} of released operation has no release data`);
      }
      return {
        partId: item.partId,
        partSku: item.partSku,
        partName: item.partName,
        quantity: item.quantity,
        stockBefore: item.releasedStockBefore,
        stockAfter: item.releasedStockAfter,
      };
    }),
  };
}

/** Única parte del sistema que modifica el stock actual. */
@Injectable()
export class StockService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Reserva todos los ítems o ninguno. Idempotente por order_id. */
  reserve(command: ReserveCommand): Promise<StockOperationResult> {
    const requestHash = requestFingerprint(command.items);

    return this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, command.orderId);

      const existing = await tx.stockOperation.findUnique({
        where: { orderId: command.orderId },
        include: INCLUDE_ITEMS,
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new OrderIdConflictError(command.orderId);
        }
        if (existing.status === 'RELEASED') {
          throw new ReservationAlreadyReleasedError(command.orderId);
        }
        return toReserveResult(existing, true);
      }

      const locked = await lockParts(tx, command.items.map((item) => item.partId));
      const partsById = new Map(locked.map((part) => [part.id, part]));

      // Todas las validaciones antes de la primera escritura: si algo falla,
      // la transacción no llegó a modificar nada.
      const missing = command.items.filter((item) => !partsById.has(item.partId)).map((item) => item.partId);
      if (missing.length > 0) {
        throw new PartsNotFoundError(missing);
      }

      const shortages = command.items.flatMap((item) => {
        const available = partsById.get(item.partId)!.stockAvailable;
        return available < item.quantity ? [{ partId: item.partId, requested: item.quantity, available }] : [];
      });
      if (shortages.length > 0) {
        throw new InsufficientStockError(shortages);
      }

      const processedAt = new Date();
      for (const item of command.items) {
        const part = partsById.get(item.partId)!;
        await tx.part.update({
          where: { id: part.id },
          data: { stockAvailable: part.stockAvailable - item.quantity, updatedAt: processedAt },
        });
      }

      const operation = await tx.stockOperation.create({
        data: {
          orderId: command.orderId,
          requestHash,
          status: 'RESERVED',
          reservedAt: processedAt,
          items: {
            create: command.items.map((item, index) => {
              const part = partsById.get(item.partId)!;
              return {
                lineNumber: index + 1,
                partId: part.id,
                partSku: part.sku,
                partName: part.name,
                quantity: item.quantity,
                reservedStockBefore: part.stockAvailable,
                reservedStockAfter: part.stockAvailable - item.quantity,
              };
            }),
          },
        },
        include: INCLUDE_ITEMS,
      });

      return toReserveResult(operation, false);
    }, TRANSACTION_OPTIONS);
  }

  /** Repone todo lo que reservó order_id, una sola vez. Idempotente por order_id. */
  release(orderId: string): Promise<StockOperationResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, orderId);

      const operation = await tx.stockOperation.findUnique({ where: { orderId }, include: INCLUDE_ITEMS });
      if (!operation) {
        throw new ReservationNotFoundError(orderId);
      }
      if (operation.status === 'RELEASED') {
        return toReleaseResult(operation, true);
      }

      // Las piezas del ledger existen siempre: la FK impide borrarlas.
      const locked = await lockParts(tx, operation.items.map((item) => item.partId));
      const partsById = new Map(locked.map((part) => [part.id, part]));
      const processedAt = new Date();

      for (const item of operation.items) {
        const before = partsById.get(item.partId)!.stockAvailable;
        const after = before + item.quantity;
        await tx.part.update({
          where: { id: item.partId },
          data: { stockAvailable: after, updatedAt: processedAt },
        });
        await tx.stockOperationItem.update({
          where: { id: item.id },
          data: { releasedStockBefore: before, releasedStockAfter: after },
        });
      }

      const released = await tx.stockOperation.update({
        where: { orderId },
        data: { status: 'RELEASED', releasedAt: processedAt },
        include: INCLUDE_ITEMS,
      });

      return toReleaseResult(released, false);
    }, TRANSACTION_OPTIONS);
  }
}
