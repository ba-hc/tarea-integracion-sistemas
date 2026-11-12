import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Dispatch } from './generated/prisma/client.js';
import { DispatchError } from './http.js';

export type DispatchItem = { partId: string; quantity: number };

function sameItems(dispatch: Dispatch, requested: DispatchItem[]): boolean {
  const stored = dispatch.items;
  return Array.isArray(stored) && stored.length === requested.length && requested.every((item, index) => {
    const saved = stored[index];
    return saved !== null && typeof saved === 'object' && !Array.isArray(saved)
      && saved.partId === item.partId && saved.quantity === item.quantity;
  });
}

@Injectable()
export class DispatchService implements OnModuleDestroy {
  private readonly db: PrismaClient;
  private readonly failCreate = process.env.DISPATCH_FAIL_CREATE === 'true';

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    this.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 }),
    });
  }

  async create(orderId: string, items: DispatchItem[]): Promise<{ dispatch: Dispatch; created: boolean }> {
    if (!this.failCreate) {
      const { count } = await this.db.dispatch.createMany({ data: { orderId, items }, skipDuplicates: true });
      if (count === 1) {
        return { dispatch: { orderId, items, status: 'CREATED' }, created: true };
      }
    }

    const dispatch = await this.db.dispatch.findUnique({ where: { orderId } });
    if (!dispatch) {
      if (this.failCreate) throw new DispatchError(503, 'DISPATCH_CREATE_REJECTED', 'Dispatch creation rejected before saving');
      throw new Error('Dispatch missing after insert conflict');
    }
    if (!sameItems(dispatch, items)) {
      throw new DispatchError(409, 'DISPATCH_CONFLICT', 'A dispatch already exists for this order with different items');
    }
    if (dispatch.status === 'CANCELLED') {
      throw new DispatchError(409, 'DISPATCH_CANCELLED', 'A cancelled dispatch cannot be recreated');
    }
    return { dispatch, created: false };
  }

  async get(orderId: string): Promise<Dispatch> {
    const dispatch = await this.db.dispatch.findUnique({ where: { orderId } });
    if (!dispatch) throw new DispatchError(404, 'DISPATCH_NOT_FOUND', 'Dispatch not found');
    return dispatch;
  }

  async cancel(orderId: string): Promise<Dispatch> {
    const [dispatch] = await this.db.dispatch.updateManyAndReturn({ where: { orderId }, data: { status: 'CANCELLED' } });
    if (!dispatch) throw new DispatchError(404, 'DISPATCH_NOT_FOUND', 'Dispatch not found');
    return dispatch;
  }

  async health(): Promise<{ status: string; service: string }> {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok', service: 'dispatch-api' };
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}
