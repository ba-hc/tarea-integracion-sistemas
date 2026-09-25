// El pipeline real (main.ts) carga reflect-metadata antes del ValidationPipe;
// la prueba hace lo mismo para transformar los DTO con sus decoradores.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateCustomerDto } from '../../src/customers/dto/create-customer.dto.js';
import { CustomerParamsDto } from '../../src/customers/dto/customer-params.dto.js';
import { ListCustomersQueryDto } from '../../src/customers/dto/list-customers-query.dto.js';

const VALID_EMAIL = 'ana.perez@repuestossur.test';

/** Aplica lo mismo que el ValidationPipe global: transformar el payload y validarlo. */
async function validatePayload<T extends object>(type: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(type, payload);
  return { instance, errors: await validate(instance) };
}

describe('CreateCustomerDto', () => {
  it('acepta un cliente válido y recorta los espacios del email', async () => {
    const { instance, errors } = await validatePayload(CreateCustomerDto, {
      name: 'Ana Perez',
      email: `  ${VALID_EMAIL} `,
    });

    expect(errors).toEqual([]);
    // La normalización a minúsculas es del servicio; aquí sólo se recorta.
    expect(instance.email).toBe(VALID_EMAIL);
  });

  it('exige name y email', async () => {
    const { errors } = await validatePayload(CreateCustomerDto, {});

    expect(errors.map((error) => error.property).sort()).toEqual(['email', 'name']);
  });

  it('acepta un nombre de 120 caracteres', async () => {
    const { errors } = await validatePayload(CreateCustomerDto, {
      name: 'a'.repeat(120),
      email: VALID_EMAIL,
    });

    expect(errors).toEqual([]);
  });

  it.each([[''], ['   '], ['a'.repeat(121)]])('rechaza el nombre %j', async (name) => {
    const { errors } = await validatePayload(CreateCustomerDto, { name, email: VALID_EMAIL });

    expect(errors.map((error) => error.property)).toEqual(['name']);
  });

  it.each([['sin-arroba'], ['ana@'], ['@repuestossur.test'], ['ana@repuestossur'], ['ana pe @repuestossur.test']])(
    'rechaza el email %j',
    async (email) => {
      const { errors } = await validatePayload(CreateCustomerDto, { name: 'Ana Perez', email });

      expect(errors.map((error) => error.property)).toEqual(['email']);
    },
  );

  it('rechaza un email de más de 254 caracteres', async () => {
    const { errors } = await validatePayload(CreateCustomerDto, {
      name: 'Ana Perez',
      email: `${'a'.repeat(250)}@repuestossur.test`,
    });

    expect(errors.map((error) => error.property)).toEqual(['email']);
  });

  it('rechaza valores que no son strings', async () => {
    const notStrings: unknown[] = [123, null, ['ana@repuestossur.test']];

    for (const email of notStrings) {
      const { errors } = await validatePayload(CreateCustomerDto, { name: 'Ana Perez', email });

      expect(errors.map((error) => error.property)).toEqual(['email']);
    }
  });
});

describe('ListCustomersQueryDto', () => {
  it('deja page y pageSize sin definir para que el servicio use 1 y 20', async () => {
    const { instance, errors } = await validatePayload(ListCustomersQueryDto, {});

    expect(errors).toEqual([]);
    expect(instance.page).toBeUndefined();
    expect(instance.pageSize).toBeUndefined();
  });

  it('convierte el query string a enteros', async () => {
    const { instance, errors } = await validatePayload(ListCustomersQueryDto, { page: '3', pageSize: '50' });

    expect(errors).toEqual([]);
    expect(instance.page).toBe(3);
    expect(instance.pageSize).toBe(50);
  });

  it('acepta pageSize=100 y rechaza pageSize=101', async () => {
    const maximo = await validatePayload(ListCustomersQueryDto, { pageSize: '100' });
    const excedido = await validatePayload(ListCustomersQueryDto, { pageSize: '101' });

    expect(maximo.errors).toEqual([]);
    expect(maximo.instance.pageSize).toBe(100);
    expect(excedido.errors.map((error) => error.property)).toEqual(['pageSize']);
  });

  it('trata un parámetro vacío como ausente', async () => {
    const { instance, errors } = await validatePayload(ListCustomersQueryDto, { page: '' });

    expect(errors).toEqual([]);
    expect(instance.page).toBeUndefined();
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['page']])('rechaza page=%j', async (page) => {
    const { errors } = await validatePayload(ListCustomersQueryDto, { page });

    expect(errors.map((error) => error.property)).toEqual(['page']);
  });
});

describe('CustomerParamsDto', () => {
  // El sistema genera los ids, así que no se fija ninguna versión de UUID.
  it.each([['00000000-0000-4000-8000-0000000000aa'], ['0198e0a4-6c31-7a2b-8d0f-1c2b3a4d5e6f']])(
    'acepta el UUID %j',
    async (customerId) => {
      const { errors } = await validatePayload(CustomerParamsDto, { customerId });

      expect(errors).toEqual([]);
    },
  );

  it.each([['nope'], ['123'], [''], ['00000000-0000-4000-8000-00000000000']])(
    'rechaza el identificador %j',
    async (customerId) => {
      const { errors } = await validatePayload(CustomerParamsDto, { customerId });

      expect(errors.map((error) => error.property)).toEqual(['customerId']);
    },
  );
});
