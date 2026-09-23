# Contrato de autenticación y autorización

## Mecanismo

Las solicitudes REST públicas utilizan:

```http
X-API-Key: <secret>
```

`/v1/health` es público. Todas las operaciones sobre clientes y órdenes requieren una key válida.

## Roles

| Rol | GET | POST |
|---|---:|---:|
| `reader` | sí | no |
| `operator` | sí | sí |

## Comportamiento de estados

- Key ausente: `401 UNAUTHORIZED`.
- Key desconocida o inválida: `401 UNAUTHORIZED`.
- Key `reader` válida en una operación POST: `403 FORBIDDEN`.
- Key `operator` válida: permitida, sujeta a la validación normal del negocio.

## Reglas de seguridad

- Las keys se entregan mediante variables de entorno o secrets y nunca se versionan en el repositorio.
- Las keys en texto plano no deben aparecer en logs, trazas, snapshots de pruebas ni mensajes de error.
- Las keys deben compararse con una comparación de tiempo constante o mediante hashes almacenados.
- Docker local puede usar HTTP; un despliegue de producción requeriría TLS en el ingress o reverse proxy.
- Los logs deben identificar el rol de la key o un identificador no secreto, nunca el secreto en sí.

## Factor de contexto para ABET 2

La seguridad de los datos de clientes y de la operación modifica materialmente el diseño: el acceso autenticado es obligatorio; los privilegios de escritura se separan de los de lectura; los secretos se externalizan; y los headers sensibles se eliminan o redactan en los logs.
