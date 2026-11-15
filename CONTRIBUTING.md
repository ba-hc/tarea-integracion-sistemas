# Contributing

## Antes de empezar

1. Revisa los contratos OpenAPI y gRPC.
2. Revisa los ADR y documentos de arquitectura relacionados con el cambio.
3. Confirma que el cambio no altera accidentalmente la línea base congelada.
4. Consulta `AGENTS.md` para las reglas operativas del repositorio.

## Flujo vigente para T2

Según el acuerdo del equipo en `Reparto-trabajo-T2.pdf`, las etapas P1 → P2 → P3 → P4 se trabajan directamente en `main`, con commits identificables por integrante. Para las tareas normales de T2 no se exige una branch ni un PR por cambio; este acuerdo reemplaza el flujo de ramas de T1. La excepción son los cambios a contratos congelados, que conservan su proceso dedicado.

- Comprueba el estado local, sitúate en `main` con `git switch main` y actualízala con `git pull --ff-only origin main` antes de comenzar. No descartes cambios locales para cambiar de rama o actualizar.
- Continúa desde el commit verificado de la etapa anterior. Si adelantas trabajo con dependencias simuladas, deja explícita la integración pendiente.
- Respeta las responsabilidades de P1, P2, P3 y P4. Coordina los cambios en archivos compartidos, especialmente Compose y CI.
- Mantén cada cambio enfocado en un objetivo principal y usa commits pequeños con el identificador de la tarea y tu autoría real.
- Incluye pruebas para comportamiento nuevo o corregido.
- Ejecuta las validaciones relevantes y entrega instrucciones, pruebas y evidencia reproducibles antes de dar por terminada una etapa.
- Antes del push, ejecuta `git fetch origin` y comprueba si `origin/main` avanzó. Integra los cambios nuevos sin sobrescribir trabajo ajeno y repite las validaciones afectadas; nunca uses force push sobre `main`.
- Publica los commits en `main` cuando corresponda. Los agentes sólo hacen push con autorización explícita del usuario.
- Evita refactors no relacionados.
- No subas secretos, `.env`, credenciales, dumps ni volúmenes locales.

Ejemplos de mensajes de commit:

```text
feat(t2-401): agregar autenticacion del gateway
test(t2-402): preparar escenarios de falla
docs(t2-403): documentar pasos de la demo
```

Las reglas operativas completas están en [AGENTS.md, sección 8](AGENTS.md#8-reglas-git).

## Contratos

Los contratos de integración se encuentran en `contracts/` y constituyen la fuente de verdad de las interfaces.

La línea base publicada es `contracts-v1.0.0`. Después de ese tag, cualquier cambio a `openapi.yaml` o `inventory.proto` debe realizarse como un cambio deliberado de contrato, con justificación, pruebas/documentación actualizadas y análisis de compatibilidad. El trabajo directo en `main` de T2 no elimina el PR dedicado exigido por [CONTRACT-FREEZE.md](docs/architecture/CONTRACT-FREEZE.md).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) se ejecuta en pull requests hacia `main`, pushes a `main` y mediante ejecución manual. Valida contratos, Docker Compose, typecheck, pruebas unitarias, integración PostgreSQL, builds, pruebas black-box y fallas de dependencia.

## Trazabilidad de contribuciones

La trazabilidad se mantiene mediante issues asignados, PRs y commits identificables. El historial de GitHub es la fuente vigente para la autoría y evolución del proyecto.

| Integrante | Responsabilidad principal | Issues principales |
|---|---|---|
| [`@ba-hc`](https://github.com/ba-hc) | Sales REST, integración gRPC, resiliencia e idempotencia pública | [RS-301 #7](https://github.com/ba-hc/tarea-integracion-sistemas/issues/7), [RS-302 #8](https://github.com/ba-hc/tarea-integracion-sistemas/issues/8), [RS-303 #9](https://github.com/ba-hc/tarea-integracion-sistemas/issues/9) |
| [`@martin777pro`](https://github.com/martin777pro) | Inventory gRPC, persistencia y motor de stock | [RS-201 #4](https://github.com/ba-hc/tarea-integracion-sistemas/issues/4), [RS-202 #5](https://github.com/ba-hc/tarea-integracion-sistemas/issues/5), [RS-203 #6](https://github.com/ba-hc/tarea-integracion-sistemas/issues/6) |
| [`@JorshSlimming`](https://github.com/JorshSlimming) | contratos, plataforma local, Docker Compose y CI/quality gates | [RS-101 #1](https://github.com/ba-hc/tarea-integracion-sistemas/issues/1), [RS-102 #2](https://github.com/ba-hc/tarea-integracion-sistemas/issues/2), [RS-103 #3](https://github.com/ba-hc/tarea-integracion-sistemas/issues/3) |
| [`@TomasGutierrez777`](https://github.com/TomasGutierrez777) | E2E black-box, experimento ABET 6 y evidencia técnica | [RS-401 #10](https://github.com/ba-hc/tarea-integracion-sistemas/issues/10), [RS-402 #11](https://github.com/ba-hc/tarea-integracion-sistemas/issues/11), [RS-403 #12](https://github.com/ba-hc/tarea-integracion-sistemas/issues/12) |

Entre las contribuciones trazables se encuentran los PRs de Inventory [#13](https://github.com/ba-hc/tarea-integracion-sistemas/pull/13), [#14](https://github.com/ba-hc/tarea-integracion-sistemas/pull/14) y [#15](https://github.com/ba-hc/tarea-integracion-sistemas/pull/15), la integración de Sales en `main`, y el PR [#16](https://github.com/ba-hc/tarea-integracion-sistemas/pull/16), que incorporó CI y los ajustes finales de auditoría.

## Definition of Done

Antes de publicar un cambio en `main` o solicitar el merge de un PR dedicado de contrato:

- lint/typecheck/tests relevantes pasan;
- el build del componente afectado pasa;
- la implementación coincide con los contratos;
- no existe acceso cruzado entre bases de datos;
- los errores públicos siguen el envelope definido;
- los cambios contractuales pasan las verificaciones de compatibilidad;
- el diff no contiene secretos ni cambios no relacionados.
