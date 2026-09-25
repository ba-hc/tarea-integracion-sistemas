import type { Order, OrderItem, OrderStatus } from '../generated/prisma/client.js';

export interface OrderView {
  id: string;
  customerId: string;
  status: OrderStatus;
  items: Array<{ partId: string; sku: string; name: string; quantity: number }>;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
}

type OrderWithItems = Order & { items: OrderItem[] };

export function toOrderView(order: OrderWithItems): OrderView {
  return {
    id: order.id,
    customerId: order.customerId,
    status: order.status,
    items: order.items.map((item) => ({
      partId: item.partId,
      sku: item.partSkuSnapshot,
      name: item.partNameSnapshot,
      quantity: item.quantity,
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt,
  };
}