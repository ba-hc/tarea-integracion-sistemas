import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '../../src/common/inventory-errors.js';
import {
  parseReleaseRequest,
  parseReserveRequest,
  requestFingerprint,
} from '../../src/stock/stock-request.js';

const ORDER = '7f3c1a52-8a0e-4c1e-9d55-1a2b3c4d5e6f';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const request = (items: Array<{ part_id: string; quantity: number }>, orderId = ORDER) => ({ order_id: orderId, items });

describe('parseReserveRequest', () => {
  it('normaliza UUID a minúsculas y conserva el orden de la solicitud', () => {
    expect(
      parseReserveRequest(request([{ part_id: B.toUpperCase(), quantity: 2 }, { part_id: A, quantity: 1 }], ORDER.toUpperCase())),
    ).toEqual({ orderId: ORDER, items: [{ partId: B, quantity: 2 }, { partId: A, quantity: 1 }] });
  });

  it.each([
    ['order_id inválido', request([{ part_id: A, quantity: 1 }], 'x'), 'order_id must be a UUID'],
    ['sin ítems', request([]), 'items must not be empty'],
    ['part_id inválido', request([{ part_id: 'x', quantity: 1 }]), 'items[0].part_id must be a UUID'],
    ['cantidad 0', request([{ part_id: A, quantity: 0 }]), 'items[0].quantity must be between 1 and 999'],
    ['cantidad 1000', request([{ part_id: A, quantity: 1000 }]), 'items[0].quantity must be between 1 and 999'],
    ['cantidad decimal', request([{ part_id: A, quantity: 1.5 }]), 'items[0].quantity must be between 1 and 999'],
    ['duplicado', request([{ part_id: A, quantity: 1 }, { part_id: A.toUpperCase(), quantity: 2 }]), 'items[1].part_id is duplicated'],
  ])('rechaza %s', (_label, input, message) => {
    expect(() => parseReserveRequest(input)).toThrow(new InvalidArgumentError(message));
  });

  it('acepta hasta 50 ítems y rechaza 51', () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ part_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, quantity: 1 }));

    expect(parseReserveRequest(request(items(50))).items).toHaveLength(50);
    expect(() => parseReserveRequest(request(items(51)))).toThrow(InvalidArgumentError);
  });
});

describe('parseReleaseRequest', () => {
  it('devuelve el order_id normalizado', () => {
    expect(parseReleaseRequest({ order_id: ORDER.toUpperCase() })).toBe(ORDER);
  });

  it('rechaza un order_id inválido', () => {
    expect(() => parseReleaseRequest({ order_id: '' })).toThrow(InvalidArgumentError);
  });
});

describe('requestFingerprint', () => {
  const fp = requestFingerprint([{ partId: A, quantity: 1 }, { partId: B, quantity: 2 }]);

  it('es un sha256 en hexadecimal', () => {
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no depende del orden de los ítems', () => {
    expect(requestFingerprint([{ partId: B, quantity: 2 }, { partId: A, quantity: 1 }])).toBe(fp);
  });

  it('cambia si cambia una cantidad, una pieza o el número de ítems', () => {
    expect(requestFingerprint([{ partId: A, quantity: 1 }, { partId: B, quantity: 3 }])).not.toBe(fp);
    expect(requestFingerprint([{ partId: A, quantity: 2 }, { partId: B, quantity: 1 }])).not.toBe(fp);
    expect(requestFingerprint([{ partId: A, quantity: 1 }])).not.toBe(fp);
  });
});
