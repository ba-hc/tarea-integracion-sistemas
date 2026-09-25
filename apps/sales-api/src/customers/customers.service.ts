import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  toCustomerListResource,
  toCustomerResource,
  type CustomerListResource,
  type CustomerResource,
} from './customer.mapper.js';

/** Predeterminados de `PaginationMeta` en openapi.yaml; `pageSize` máximo: 100. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

export interface CreateCustomerInput {
  name: string;
  email: string;
}

/** Paginación ya validada por el DTO de query; ambos campos son opcionales. */
export interface CustomerListQuery {
  page?: number;
  pageSize?: number;
}

/**
 * El email del cliente es único sin distinguir mayúsculas ni espacios
 * (SYSTEM-DESIGN.md). Se normaliza antes de persistir y por lo tanto también
 * antes de comparar, así `Ana@X.COM` y ` ana@x.com ` son el mismo cliente.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Única señal fiable de que la restricción única del email se violó: Prisma
 * reporta toda violación de índice único con el código `P2002`. Se comprueba
 * de forma estructural para no depender de la clase de error generada.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

@Injectable()
export class CustomersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Inserta el cliente y traduce un email repetido a 409. No se consulta antes
   * de insertar: la restricción única de la base es la única autoridad, de modo
   * que dos requests concurrentes tampoco pueden crear el mismo email.
   */
  async create(input: CreateCustomerInput): Promise<CustomerResource> {
    try {
      const customer = await this.prisma.customer.create({
        data: { name: input.name, email: normalizeEmail(input.email) },
      });
      return toCustomerResource(customer);
    } catch (error) {
      // El error de Prisma no se reexpone: el cliente sólo ve el código y el
      // mensaje del contrato, nunca el texto de la base.
      if (isUniqueConstraintViolation(error)) {
        throw new ApiError(409, 'CUSTOMER_EMAIL_CONFLICT', 'A customer with this email already exists');
      }
      throw error;
    }
  }

  async findById(customerId: string): Promise<CustomerResource> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (customer === null) {
      throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    }
    return toCustomerResource(customer);
  }

  async list(query: CustomerListQuery = {}): Promise<CustomerListResource> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const [total, customers] = await Promise.all([
      this.prisma.customer.count(),
      this.prisma.customer.findMany({
        // Orden estable: más recientes primero y `id` como desempate, para que
        // dos filas con el mismo `createdAt` no cambien de página entre llamadas.
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return toCustomerListResource(customers, { page, pageSize, total });
  }
}
