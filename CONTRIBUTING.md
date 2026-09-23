# Contributing

## Antes de empezar

1. Lee `AGENTS.md`.
2. Revisa el OpenAPI, `.proto` y ADR relacionados con el cambio.
3. Confirma que el cambio no altera accidentalmente un contrato congelado.

## Flujo recomendado

- Crea una branch corta y descriptiva desde `main`.
- Mantén el PR enfocado en un objetivo principal.
- Incluye pruebas para comportamiento nuevo o corregido.
- Evita refactors no relacionados.
- No subas secretos, `.env`, credenciales, dumps ni volúmenes locales.

Ejemplos de branches:

```text
feat/inventory-catalog
feat/orders-api
fix/stock-concurrency
contract/add-compatible-field
```

## Contratos

Los contratos se encuentran en `contracts/` y se consideran fuente de verdad.

Después de `contracts-v1.0.0`, cualquier cambio a `openapi.yaml` o `inventory.proto` debe ir en un PR dedicado de contrato con justificación, pruebas/documentación actualizadas y análisis de compatibilidad.

## Definition of Done

Antes de solicitar merge:

- lint/typecheck/tests relevantes pasan;
- el build del componente afectado pasa;
- la implementación coincide con el contrato;
- no existe acceso cruzado entre bases de datos;
- los errores públicos siguen el envelope definido;
- el diff no contiene secretos ni cambios no relacionados.
