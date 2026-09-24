# RS-401 · Suite de sistema black-box

Valida el comportamiento observable del sistema integrado desde fuera: solo HTTP contra `/v1`.
La suite no conoce tablas, ORMs ni detalles internos de Sales o Inventory.

Fuentes de verdad: [TEST-MATRIX.md](../../docs/architecture/TEST-MATRIX.md),
[openapi.yaml](../../contracts/rest/openapi.yaml) y
[inventory.proto](../../contracts/grpc/repuestossur/inventory/v1/inventory.proto).

## Cómo se verifica el stock sin mirar la base de Inventory

Ningún endpoint REST expone el stock, así que la suite no puede leerlo. En vez de romper la
regla black-box consultando Inventory por gRPC, lo verifica **por comportamiento**: si la pieza
de pruebas tiene `N` unidades, deben entrar exactamente `N` órdenes y la `N+1` debe devolver
409. Cancelar una repone exactamente una unidad, ni más.

Esto prueba el descuento y la reposición usando solo el contrato público, y de paso evita
meter un cliente gRPC en la suite.

El escenario consume todo el stock de la pieza y lo repone al terminar, así que la suite se
puede repetir contra el mismo stack sin resembrar.

## Requisitos

- Node.js 24 y el stack de RepuestosSur levantado.
- Para las pruebas de falla, además: Docker, `bash` y el perfil `experiment` de Compose
  (necesita Toxiproxy entre Sales e Inventory).

Del resto del equipo:

| Issue | Qué se necesita |
|---|---|
| RS-201 | Una pieza en el seed con UUID fijo y **stock bajo y conocido** (5 unidades) |
| RS-301 | Dos API keys inyectables por entorno: una `reader` y una `operator` |
| RS-102 | Perfil `experiment` en Compose, para las pruebas de falla |

## Variables de entorno

| Variable | Obligatoria | Por defecto | Para qué |
|---|---|---|---|
| `SALES_BASE_URL` | no | `http://localhost:3000` | dónde responde Sales |
| `API_KEY_OPERATOR` | sí | — | key con rol `operator` |
| `API_KEY_READER` | sí | — | key con rol `reader` |
| `PART_WITH_STOCK` | sí | — | UUID de la pieza de pruebas |
| `PART_STOCK` | no | `5` | stock exacto con el que está sembrada |
| `PART_UNKNOWN` | no | UUID fijo inexistente | para el caso 422 |
| `RUN_FAILURE_TESTS` | no | — | `1` activa las pruebas de falla |
| `INVENTORY_SERVICE` | no | `inventory-grpc` | nombre del servicio en Compose |

`PART_WITH_STOCK` debe apuntar a la pieza de stock bajo, **no** a la del experimento RS-402.
La suite aborta si `PART_STOCK` queda fuera del rango 1–20, para no lanzar 50.000 órdenes por
accidente.

## Ejecución

```bash
cd tests/system
npm install

export API_KEY_OPERATOR=<key operator>
export API_KEY_READER=<key reader>
export PART_WITH_STOCK=<uuid de la pieza de pruebas>

npm test
```

Las pruebas de falla se corren aparte, porque detienen y ralentizan Inventory:

```bash
RUN_FAILURE_TESTS=1 npm test
```

Los archivos se ejecutan en serie (`--no-file-parallelism`): varias pruebas comparten la misma
pieza y correrlas en paralelo haría que se pisaran el stock.

## Qué cubre

| Archivo | Casos |
|---|---|
| `auth.test.ts` | sin key → 401, key inválida → 401, `reader` GET, `reader` POST → 403, `operator` POST, `/v1/health` público |
| `customers.test.ts` | crear, consultar, inexistente → 404, email duplicado → 409, paginación por defecto y máximo |
| `orders.test.ts` | ciclo de stock completo, cancelación repetida, idempotencia (mismo y distinto payload), validación, cliente → 404, pieza → 422, orden → 404 |
| `failures.test.ts` | Inventory detenido → 503, Inventory lento → 504, recuperación |

Cuando una aserción falla, el mensaje incluye el código recibido y el cuerpo completo de la
respuesta, no un `true !== false`. Los errores además se verifican contra el envelope
congelado: `code`, `message` y `traceId`.

## Estado

La suite está escrita contra los contratos congelados y **todavía no se ha ejecutado**: depende
de que estén mergeados RS-102, RS-201/202 y RS-301/302/303. Hasta entonces fallará por no poder
conectar con Sales, que es el comportamiento esperado en un flujo contract-first.
