import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/common/api-error.js';
import { toCustomerResource, type CustomerRecord, type CustomerResource } from '../../src/customers/customer.mapper.js';
import {
  CustomersService,
  isUniqueConstraintViolation,
  normalizeEmail,
} from '../../src/customers/customers.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';

const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000aa';

/** Fila tal como la devuelve Prisma, con los timestamps como `Date`. */
const ROW: CustomerRecord = {
  id: CUSTOMER_ID,
  name: 'Ana Perez',
  email: 'ana.perez@repuestossur.test',
  createdAt: new Date('2026-09-25T12:34:56.000Z'),
  updatedAt: new Date('2026-09-25T13:00:00.250Z'),
};

/** Recurso público esperado: mismos datos, timestamps en RFC 3339. */
const RESOURCE: CustomerResource = {
  id: CUSTOMER_ID,
  name: 'Ana Perez',
  email: 'ana.perez@repuestossur.test',
  createdAt: '2026-09-25T12:34:56.000Z',
  updatedAt: '2026-09-25T13:00:00.250Z',
};

const ORDER_BY = [
  { createdAt: 'desc' },
  { id: 'asc' },
];

/**
 * Error con la forma real de Prisma para una violación de índice único. El
 * mensaje contiene texto de la base a propósito: el servicio no debe
 * reenviarlo nunca al cliente.
 */
function uniqueConstraintFailure(): Error {
  return Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: { modelName: 'Customer', target: ['email'] },
  });
}

/** Devuelve el error con el que falló la promesa, y falla si resolvió. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba que la operación fallara');
}

/** Comprueba que el error es del tipo del contrato y lo entrega tipado. */
function expectApiError(error: unknown): ApiError {
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) {
    throw new Error(`se esperaba ApiError, se recibió ${String(error)}`);
  }
  return error;
}

describe('normalizeEmail', () => {
  it.each([
    ['  ANA.PEREZ@RepuestosSur.TEST ', 'ana.perez@repuestossur.test'],
    ['ana.perez@repuestossur.test', 'ana.perez@repuestossur.test'],
  ])('normaliza %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
});

describe('isUniqueConstraintViolation', () => {
  it('reconoce el código P2002 de Prisma', () => {
    expect(isUniqueConstraintViolation(uniqueConstraintFailure())).toBe(true);
  });

  it('no clasifica valores que no son violaciones de unicidad', () => {
    const notUniqueViolations: unknown[] = [
      new Error('connection terminated unexpectedly'),
      null,
      undefined,
      'P2002',
      { code: 'P2025' },
      { code: 2002 },
    ];

    for (const value of notUniqueViolations) {
      expect(isUniqueConstraintViolation(value)).toBe(false);
    }
  });
});

describe('toCustomerResource', () => {
  it('serializa las fechas y expone sólo los campos del contrato', () => {
    const rowWithInternalColumns: CustomerRecord & { deletedAt: string | null } = {
      ...ROW,
      deletedAt: null,
    };

    expect(toCustomerResource(rowWithInternalColumns)).toEqual(RESOURCE);
  });
});

describe('CustomersService', () => {
  const create = vi.fn();
  const findUnique = vi.fn();
  const findMany = vi.fn();
  const count = vi.fn();
  let service: CustomersService;

  beforeEach(() => {
    create.mockReset();
    findUnique.mockReset();
    findMany.mockReset();
    count.mockReset();

    // El mock sólo implementa el delegado `customer`, que es el único que usa el servicio.
    const prisma = { customer: { create, findUnique, findMany, count } } as unknown as PrismaService;
    service = new CustomersService(prisma);
  });

  describe('create', () => {
    it('persiste el email normalizado y devuelve el recurso público', async () => {
      create.mockResolvedValue(ROW);

      await expect(service.create({ name: 'Ana Perez', email: '  ANA.Perez@RepuestosSur.TEST ' })).resolves.toEqual(
        RESOURCE,
      );
      expect(create).toHaveBeenCalledWith({
        data: { name: 'Ana Perez', email: 'ana.perez@repuestossur.test' },
      });
    });

    it('traduce la violación de unicidad del email a 409 CUSTOMER_EMAIL_CONFLICT', async () => {
      create.mockRejectedValue(uniqueConstraintFailure());

      const error = expectApiError(
        await captureError(service.create({ name: 'Ana Perez', email: 'ana.perez@repuestossur.test' })),
      );

      expect(error.getStatus()).toBe(409);
      expect(error.code).toBe('CUSTOMER_EMAIL_CONFLICT');
      // El mensaje es el del contrato: el texto de Prisma no se reenvía.
      expect(error.message).toBe('A customer with this email already exists');
    });

    it('propaga los errores que no son conflictos de unicidad', async () => {
      const failure = new Error('connection terminated unexpectedly');
      create.mockRejectedValue(failure);

      await expect(service.create({ name: 'Ana Perez', email: 'ana.perez@repuestossur.test' })).rejects.toBe(failure);
    });
  });

  describe('findById', () => {
    it('consulta por id y devuelve el recurso público', async () => {
      findUnique.mockResolvedValue(ROW);

      await expect(service.findById(CUSTOMER_ID)).resolves.toEqual(RESOURCE);
      expect(findUnique).toHaveBeenCalledWith({ where: { id: CUSTOMER_ID } });
    });

    it('lanza 404 CUSTOMER_NOT_FOUND cuando el cliente no existe', async () => {
      findUnique.mockResolvedValue(null);

      const error = expectApiError(await captureError(service.findById(CUSTOMER_ID)));

      expect(error.getStatus()).toBe(404);
      expect(error.code).toBe('CUSTOMER_NOT_FOUND');
      expect(error.message).toBe('Customer not found');
    });
  });

  describe('list', () => {
    it('usa page=1 y pageSize=20 por defecto, con orden estable', async () => {
      findMany.mockResolvedValue([ROW]);
      count.mockResolvedValue(1);

      await expect(service.list()).resolves.toEqual({
        page: 1,
        pageSize: 20,
        total: 1,
        items: [RESOURCE],
      });
      expect(findMany).toHaveBeenCalledWith({ orderBy: ORDER_BY, skip: 0, take: 20 });
      expect(count).toHaveBeenCalledWith();
    });

    it('calcula skip y take a partir de page y pageSize', async () => {
      findMany.mockResolvedValue([ROW]);
      count.mockResolvedValue(101);

      await expect(service.list({ page: 3, pageSize: 100 })).resolves.toEqual({
        page: 3,
        pageSize: 100,
        total: 101,
        items: [RESOURCE],
      });
      expect(findMany).toHaveBeenCalledWith({ orderBy: ORDER_BY, skip: 200, take: 100 });
    });

    it('mantiene pageSize=20 por defecto cuando sólo se indica page', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await expect(service.list({ page: 2 })).resolves.toEqual({
        page: 2,
        pageSize: 20,
        total: 0,
        items: [],
      });
      expect(findMany).toHaveBeenCalledWith({ orderBy: ORDER_BY, skip: 20, take: 20 });
    });
  });
});
