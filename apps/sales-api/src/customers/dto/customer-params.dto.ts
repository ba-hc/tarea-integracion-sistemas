import { IsUUID } from 'class-validator';

/**
 * Parámetros de ruta que identifican a un cliente (`CustomerId` en
 * openapi.yaml). `@IsUUID()` sin versión acepta cualquier UUID, porque los ids
 * los genera la base y no deben quedar fijados a una versión concreta.
 */
export class CustomerParamsDto {
  @IsUUID()
  customerId!: string;
}
