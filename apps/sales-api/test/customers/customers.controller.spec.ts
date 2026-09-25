import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerResource } from '../../src/customers/customer.mapper.js';
import { CustomersController } from '../../src/customers/customers.controller.js';
import type { CustomersService } from '../../src/customers/customers.service.js';

const CREATED: CustomerResource = {
  id: '00000000-0000-4000-8000-0000000000aa',
  name: 'Ana Perez',
  email: 'ana.perez@repuestossur.test',
  createdAt: '2026-09-25T12:34:56.000Z',
  updatedAt: '2026-09-25T12:34:56.000Z',
};

describe('CustomersController', () => {
  const create = vi.fn();
  const header = vi.fn();
  let controller: CustomersController;

  beforeEach(() => {
    create.mockReset();
    header.mockReset();

    const service = { create, findById: vi.fn(), list: vi.fn() } as unknown as CustomersService;
    controller = new CustomersController(service);
  });

  it('publica Location con la ruta del cliente creado', async () => {
    create.mockResolvedValue(CREATED);

    await controller.create({ name: 'Ana Perez', email: CREATED.email }, { header });

    // El contrato exige el header en el 201; la ruta relativa es la del recurso.
    expect(header).toHaveBeenCalledWith('Location', `/v1/customers/${CREATED.id}`);
  });

  it('no publica Location cuando la creación falla', async () => {
    create.mockRejectedValue(new Error('fallo inesperado'));

    await expect(controller.create({ name: 'Ana Perez', email: CREATED.email }, { header })).rejects.toThrow(
      'fallo inesperado',
    );
    expect(header).not.toHaveBeenCalled();
  });
});
