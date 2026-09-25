# Procedimiento de congelamiento de contratos

## Línea base congelada

La línea base de integración corresponde a estos archivos:

- `contracts/rest/openapi.yaml`
- `contracts/grpc/repuestossur/inventory/v1/inventory.proto`
- `contracts/buf.yaml`
- `contracts/CHANGELOG.md`

El tag publicado `contracts-v1.0.0` apunta al commit `8289b5eeed4e4dedc8fe974e27566f21dfc67401`. No se debe mover ni recrear ese tag.

Los ADR y documentos de arquitectura explican y pueden evolucionar independientemente; no forman parte de la línea base inmutable mientras no cambien esos archivos de contrato.

## Regla de congelamiento

Después de `contracts-v1.0.0`, el trabajo de implementación DEBE consumir estos contratos como entradas inmutables. Un contrato no debe editarse de forma casual para facilitar una implementación.

### Cambio compatible

Requiere un PR dedicado con prefijo `contract:` que:

- explique por qué se necesita el cambio;
- actualice las pruebas y documentación de contrato afectadas;
- demuestre compatibilidad con los consumidores existentes.

### Cambio incompatible

Requiere:

- una nueva versión mayor de API/package (`/v2` o `inventory.v2`);
- notas de migración;
- todas las pruebas afectadas actualizadas deliberadamente;
- un nuevo tag de contratos.

## Controles de CI para contratos

`.github/workflows/ci.yml` valida los contratos en PRs y en push a `main`:

```bash
npx --yes @redocly/cli@2.54.2 lint contracts/rest/openapi.yaml
oasdiff breaking --fail-on ERR \
  'refs/tags/contracts-v1.0.0:contracts/rest/openapi.yaml' \
  'HEAD:contracts/rest/openapi.yaml'
buf lint contracts/grpc
buf breaking contracts/grpc --against '.git#tag=contracts-v1.0.0,subdir=contracts/grpc'
docker compose config --quiet
```
