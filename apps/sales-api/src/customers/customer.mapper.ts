/**
 * Cliente tal como lo devuelve Prisma. Se declara localmente para no depender
 * del cliente generado: el modelo `Customer` pertenece al esquema de Sales y
 * la única forma pública del recurso es la del contrato.
 */
export interface CustomerRecord {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Recurso público `Customer` de openapi.yaml. */
export interface CustomerResource {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

/** Respuesta de `GET /v1/customers` (`CustomerList` + `PaginationMeta`). */
export interface CustomerListResource {
  page: number;
  pageSize: number;
  total: number;
  items: CustomerResource[];
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Construye la representación pública: exactamente los cinco campos del
 * contrato, con los timestamps en RFC 3339. Se arma campo por campo para que
 * ninguna columna interna llegue a la respuesta por accidente.
 */
export function toCustomerResource(customer: CustomerRecord): CustomerResource {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  };
}

export function toCustomerListResource(
  customers: readonly CustomerRecord[],
  pagination: PaginationMeta,
): CustomerListResource {
  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: pagination.total,
    items: customers.map((customer) => toCustomerResource(customer)),
  };
}
