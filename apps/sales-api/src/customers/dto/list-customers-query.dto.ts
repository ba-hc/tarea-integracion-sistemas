import { Transform, type TransformFnParams } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Convierte el valor del query string en número. Un parámetro ausente o vacío
 * queda indefinido (el servicio aplica los predeterminados del contrato) y
 * cualquier valor no numérico se convierte en `NaN`, que `@IsInt` rechaza: un
 * `page=abc` nunca llega a la consulta.
 */
const toInteger = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? Number(value) : value;
};

/**
 * Query de `GET /v1/customers` (`Page` y `PageSize` en openapi.yaml):
 * enteros, `page >= 1` y `pageSize` entre 1 y 100.
 */
export class ListCustomersQueryDto {
  @Transform(toInteger)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Transform(toInteger)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
