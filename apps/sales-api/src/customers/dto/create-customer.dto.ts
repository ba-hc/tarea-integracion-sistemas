import { Transform, type TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

/**
 * Quita espacios accidentales antes de validar, para que las longitudes y el
 * formato se evalúen sobre el valor que realmente se va a persistir.
 */
const trim = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value);

/**
 * Cuerpo de `POST /v1/customers` (`CustomerCreateRequest` en openapi.yaml):
 * `name` de 1 a 120 caracteres y `email` con formato de email de hasta 254.
 *
 * El email se compara y se guarda en minúsculas, pero esa normalización vive en
 * el servicio: es una regla de dominio del cliente, no del transporte HTTP.
 */
export class CreateCustomerDto {
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name!: string;

  @Transform(trim)
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
