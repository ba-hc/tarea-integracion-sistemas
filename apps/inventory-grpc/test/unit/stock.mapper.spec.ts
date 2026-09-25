import { describe, expect, it } from 'vitest';
import { toStockResponse } from '../../src/stock/stock.mapper.js';

describe('toStockResponse', () => {
  it('arma el mensaje del contrato con la foto de la pieza tras el movimiento', () => {
    const response = toStockResponse({
      orderId: '7f3c1a52-8a0e-4c1e-9d55-1a2b3c4d5e6f',
      processedAt: new Date('2026-09-24T12:00:00.500Z'),
      replayed: true,
      items: [
        { partId: 'p1', partSku: 'SKU-1', partName: 'Pieza 1', quantity: 3, stockBefore: 10, stockAfter: 7 },
      ],
    });

    const processedAt = { seconds: 1790251200, nanos: 500_000_000 };
    expect(response).toEqual({
      order_id: '7f3c1a52-8a0e-4c1e-9d55-1a2b3c4d5e6f',
      items: [
        {
          part: { id: 'p1', sku: 'SKU-1', name: 'Pieza 1', stock_available: 7, updated_at: processedAt },
          quantity: 3,
          stock_before: 10,
          stock_after: 7,
        },
      ],
      processed_at: processedAt,
      replayed: true,
    });
  });
});
