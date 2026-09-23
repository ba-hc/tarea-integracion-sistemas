# Procedimiento de congelamiento de contratos

## Línea base congelada

La línea base de integración corresponde exactamente a:

- `contracts/rest/openapi.yaml`
- `contracts/grpc/repuestossur/inventory/v1/inventory.proto`
- `contracts/buf.yaml`
- ADR-001 hasta ADR-004
- políticas de arquitectura en `docs/architecture/`

Después de validar e integrar a `main`, crear:

```bash
git tag -a contracts-v1.0.0 -m "Congelar contratos REST y gRPC de RepuestosSur v1.0.0"
git push origin contracts-v1.0.0
```

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

## Controles requeridos antes de crear el tag

```bash
# estilo y compilación de protobuf
buf lint contracts/grpc

# una vez que exista la línea base, los PR futuros también ejecutan:
buf breaking contracts/grpc --against '.git#tag=contracts-v1.0.0,subdir=contracts/grpc'
```

CI también debe validar `contracts/rest/openapi.yaml` con un validador compatible con OpenAPI 3.1 y puede usar una herramienta de diff de OpenAPI para rechazar cambios REST incompatibles respecto del tag congelado.
