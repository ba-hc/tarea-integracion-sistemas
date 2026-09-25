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

## CI

`.github/workflows/ci.yml` runs on GitHub-hosted runners for pull requests to `main`, pushes to `main`, and manual dispatch. It validates OpenAPI and protobuf compatibility, Compose configuration, Inventory and Sales unit/integration tests and builds, plus black-box API and dependency-failure tests through Toxiproxy.

## Trazabilidad de contribuciones

Snapshot de GitHub `main` en `2ae5ca67` (2026-09-25), anterior a esta rama. Los commits cuentan autoría visible en GitHub; cerrar un issue no demuestra que sus cambios estén en `main`.

| Integrante | Issues y PRs vinculados | Commits visibles en `main` |
|---|---|---:|
| `@ba-hc` | [RS-301 (#7)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/7); implementación integrada de Sales en [2ae5ca6](https://github.com/ba-hc/tarea-integracion-sistemas/commit/2ae5ca67f9509cd596e1fdeb7abf1551ab2a1cf5) | 23 |
| `@martin777pro` | [RS-201 (#4)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/4), [RS-202 (#5)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/5), [RS-203 (#6)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/6); PRs [#13](https://github.com/ba-hc/tarea-integracion-sistemas/pull/13), [#14](https://github.com/ba-hc/tarea-integracion-sistemas/pull/14), [#15](https://github.com/ba-hc/tarea-integracion-sistemas/pull/15) | 18 |
| `@TomasGutierrez777` | [RS-401 (#10)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/10), [RS-402 (#11)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/11); commits [31c245e](https://github.com/ba-hc/tarea-integracion-sistemas/commit/31c245e6ce83fff30640fcef44c97bd576f5c274), [3c9a8cb](https://github.com/ba-hc/tarea-integracion-sistemas/commit/3c9a8cb90872200326fde9002a0449d997ff5b7a), [eb74b88](https://github.com/ba-hc/tarea-integracion-sistemas/commit/eb74b888030b0ef3cbff2c4cd703c495fb5cefea), [e458a6c](https://github.com/ba-hc/tarea-integracion-sistemas/commit/e458a6ccf3b2097ccc71ec5bbe912fa134685357) | 4 |
| `@JorshSlimming` | [RS-101 (#1)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/1), [RS-102 (#2)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/2), [RS-103 (#3)](https://github.com/ba-hc/tarea-integracion-sistemas/issues/3); tag publicado [`contracts-v1.0.0`](https://github.com/ba-hc/tarea-integracion-sistemas/tree/contracts-v1.0.0) | 0 |

Corrección de @JorshSlimming: la descripción anterior de toda mi contribución como local fue un error mío; no sé por qué omití el tag. `contracts-v1.0.0` sí está publicado en GitHub: el tag anotado identifica a Jorsh Slimming como tagger y apunta al commit [`8289b5e`](https://github.com/ba-hc/tarea-integracion-sistemas/commit/8289b5eeed4e4dedc8fe974e27566f21dfc67401). El contador `0` sólo cuenta commits de Jorsh en `main` remoto al snapshot `2ae5ca67`; publicar el tag es una contribución separada. Los comentarios de cierre de [#1](https://github.com/ba-hc/tarea-integracion-sistemas/issues/1#issuecomment-5832348782), [#2](https://github.com/ba-hc/tarea-integracion-sistemas/issues/2#issuecomment-5832349324) y [#3](https://github.com/ba-hc/tarea-integracion-sistemas/issues/3#issuecomment-5832349926) se referían a los commits de implementación que quedaron en `main` local, no a la publicación del tag.

## Definition of Done

Antes de solicitar merge:

- lint/typecheck/tests relevantes pasan;
- el build del componente afectado pasa;
- la implementación coincide con el contrato;
- no existe acceso cruzado entre bases de datos;
- los errores públicos siguen el envelope definido;
- el diff no contiene secretos ni cambios no relacionados.
