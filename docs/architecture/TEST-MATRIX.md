# Matriz de aceptación a nivel de contrato

Estas pruebas definen la línea base de aceptación black-box y no deben requerir cambios en la interfaz congelada.

## Autenticación
- GET de cliente sin key -> 401
- key inválida -> 401
- `reader` con GET -> éxito
- `reader` con POST -> 403
- `operator` con POST -> éxito

## Clientes
- crear cliente válido -> 201 + Location
- email normalizado duplicado -> 409
- obtener cliente inexistente -> 404
- validar valores predeterminados y máximo de paginación

## Órdenes
- cliente válido + todo el stock disponible -> 201 CONFIRMED
- cliente desconocido -> 404, Inventory no se modifica
- pieza desconocida -> 422, sin mutación parcial de stock
- stock insuficiente -> 409, sin mutación parcial de stock
- IDs de piezas duplicados en la solicitud -> 400
- cantidad inválida -> 400
- misma `Idempotency-Key` + mismo payload -> misma orden, sin segundo descuento de stock
- retry tras cancelar -> se reproduce el cuerpo original de creación, sin reservar otra vez
- misma `Idempotency-Key` + payload distinto -> 409
- solicitudes concurrentes con la misma key y payload -> una reserva y la misma orden
- falla de persistencia después de reservar -> compensación serializada; retry concurrente no confirma una reserva liberada
- ACK de commit perdido -> se conserva la orden confirmada y no se libera su reserva

## Cancelación
- orden confirmada -> 200 CANCELLED y stock repuesto una sola vez
- cancelación repetida -> 200 con el mismo estado CANCELLED y sin segunda liberación
- orden desconocida -> 404

## Falla de dependencia
- Inventory detenido -> crear/cancelar devuelve 503 dentro de un tiempo acotado
- Inventory retrasado más de 800 ms -> crear/cancelar devuelve 504
- reintento explícito tras 5xx/timeout ambiguo con la misma `Idempotency-Key` -> una sola reserva efectiva
- una orden no debe pasar a CONFIRMED si falla la reserva
- una orden no debe pasar a CANCELLED si falla la liberación
- release completado + persistencia local fallida -> retry de cancelación completa el estado sin liberar stock dos veces

## Concurrencia de Inventory
Dado stock=10, 20 reservas concurrentes de cantidad 1 para IDs de orden distintos deben producir exactamente 10 éxitos, 10 fallas por stock y stock final 0.

## Docker
Desde un estado limpio, `docker compose up --build` debe ser suficiente para iniciar todos los servicios obligatorios.
