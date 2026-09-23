# ADR-003 - Versionado contract-first y política de compatibilidad

**Estado:** Aceptada

## Contexto
La implementación debe poder evolucionar sin cambiar inesperadamente las suposiciones de integración. Por ello, los contratos necesitan una estrategia explícita de evolución para cambios compatibles y cambios incompatibles.

## Alternativas consideradas
1. **Code-first y generar los contratos después.** Es rápido al comienzo, pero genera divergencias y fallas de integración al momento de hacer merge.
2. **Contract-first sin controles de compatibilidad.** Mejora la coordinación, pero cambios incompatibles accidentales todavía pueden llegar a `main`.
3. **Contract-first con tags semánticos y verificaciones automáticas de compatibilidad.** Requiere más disciplina, pero permite implementar de forma independiente con mayor seguridad.

## Decisión
Congelar la línea base como el tag Git `contracts-v1.0.0` una vez que ambos archivos de contrato estén integrados y validados.

Reglas de versionado:
- La versión mayor de REST se codifica en la ruta: `/v1`.
- La versión mayor de gRPC se codifica en el package: `repuestossur.inventory.v1`.
- Las versiones de contratos usan tags semánticos `contracts-vMAJOR.MINOR.PATCH`.
- Los cambios aditivos compatibles pueden permanecer en v1.
- Los cambios incompatibles de comportamiento o esquema requieren `/v2` y/o `inventory.v2`.

## Cambios compatibles en v1
- Añadir un nuevo campo opcional a una respuesta REST.
- Añadir un nuevo endpoint REST.
- Añadir un nuevo campo protobuf usando un número de campo nuevo.
- Añadir un nuevo RPC protobuf siempre que los consumidores existentes continúen siendo válidos.

## Cambios incompatibles que requieren una versión mayor
- Eliminar o renombrar un campo REST requerido.
- Cambiar el significado o el tipo de un campo REST existente.
- Eliminar un endpoint o cambiar de forma incompatible la semántica existente de éxito o error.
- Cambiar el número de un campo protobuf o reutilizar el número de un campo eliminado.
- Cambiar un campo protobuf a un tipo de wire incompatible.
- Eliminar o renombrar un RPC utilizado por consumidores.

## Proceso de cambio
Después del congelamiento, ningún archivo de contrato se modifica como efecto secundario de una feature. Las modificaciones de contrato requieren un PR dedicado al contrato, con las pruebas y documentación afectadas actualizadas. Un cambio incompatible requiere una nueva versión mayor y un plan de migración.

## Costo aceptado
Los cambios pequeños pueden tomar más tiempo porque la interfaz se controla deliberadamente.

## Consecuencias
- `buf lint` y `buf breaking --against '.git#tag=contracts-v1.0.0'` son controles de CI para protobuf.
- Debe ejecutarse un verificador de cambios incompatibles de OpenAPI contra la línea base congelada.
- Los campos protobuf eliminados deben reservar tanto su número de campo anterior como su nombre.
- Los consumidores pueden implementar contra los archivos congelados independientemente del orden de implementación.
