import { ApiError } from '../common/api-error.js';

/**
 * Resultado de ejecutar un paso de la Saga contra otro servicio.
 *
 * - `done`: el servicio confirmó el efecto (stock reservado, cobro aplicado,
 *   despacho creado).
 * - `rejected`: el servicio confirmó que NO aplicó el efecto (stock
 *   insuficiente, pago rechazado, Despacho rechazó antes de guardar, o la
 *   conexión nunca se estableció). Es seguro compensar los pasos anteriores.
 * - `in_doubt`: no sabemos si el efecto ocurrió (timeout, 5xx genérico,
 *   conexión cortada a mitad de camino). El paso sólo se resuelve repitiendo el
 *   mismo comando idempotente o, pasado el plazo de aborto, compensándolo.
 *
 * `error` es el error público (envelope REST) que verá el cliente.
 */
export type StepOutcome<T = undefined> =
  | { kind: 'done'; value: T }
  | { kind: 'rejected'; error: ApiError }
  | { kind: 'in_doubt'; error: ApiError };

/**
 * Resultado de compensar un paso.
 *
 * - `compensated`: el efecto quedó revertido o se confirmó que nunca existió.
 * - `retry`: no se pudo confirmar; la compensación queda pendiente y se
 *   reintenta con backoff (mismo comando idempotente).
 */
export type CompensationOutcome =
  | { kind: 'compensated' }
  | { kind: 'retry'; error: ApiError };

export const INTERNAL_ERROR = (): ApiError =>
  new ApiError(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');

export const PAYMENT_UNAVAILABLE = (): ApiError =>
  new ApiError(503, 'PAYMENT_UNAVAILABLE', 'Payment service is unavailable');
export const PAYMENT_TIMEOUT = (): ApiError =>
  new ApiError(504, 'PAYMENT_TIMEOUT', 'Payment service did not respond before the deadline');
export const PAYMENT_DECLINED = (): ApiError =>
  new ApiError(422, 'PAYMENT_DECLINED', 'The payment was declined');

export const DISPATCH_UNAVAILABLE = (): ApiError =>
  new ApiError(503, 'DISPATCH_UNAVAILABLE', 'Dispatch service is unavailable');
export const DISPATCH_TIMEOUT = (): ApiError =>
  new ApiError(504, 'DISPATCH_TIMEOUT', 'Dispatch service did not respond before the deadline');
