# ADR-001 - Separación de los contextos delimitados de Ventas e Inventario

**Estado:** Aceptada

## Contexto
RepuestosSur tiene dos responsabilidades preexistentes que evolucionan por razones distintas: Ventas es responsable de los clientes y las órdenes de venta, mientras que Inventario es responsable de las piezas y el stock. El encargo también exige una base de datos por servicio y prohíbe que un servicio acceda directamente a la base de datos de otro.

## Alternativas consideradas
1. **Un único monolito y una sola base de datos.** Simplifica el despliegue y las transacciones, pero no representa el problema de integración requerido y vulnera la separación de servicios exigida.
2. **Dos servicios con una base de datos compartida.** Mantiene límites de proceso, pero acopla ambos servicios mediante un esquema compartido oculto y vulnera el principio de una base de datos por servicio.
3. **Dos servicios con bases de datos independientes y contratos explícitos.** Añade complejidad de red y de sistema distribuido, pero conserva los límites de responsabilidad y hace que la integración sea observable y comprobable.

## Decisión
Usar dos servicios desplegables de forma independiente:
- **Sales:** clientes, órdenes, registros de idempotencia y snapshots inmutables de piezas utilizados por las órdenes.
- **Inventory:** piezas, stock disponible y registro de movimientos de stock.

Sales se comunica con Inventory únicamente mediante el contrato gRPC versionado. No se permiten lecturas ni escrituras cruzadas entre bases de datos.

## Justificación
La separación sigue las dos fuentes de verdad descritas en el problema. Inventory mantiene la autoridad sobre el stock actual. Sales mantiene la autoridad sobre los clientes y el ciclo de vida de las órdenes. Se acepta una pequeña duplicación intencional: una orden almacena el `sku` y el `name` de la pieza devueltos por Inventory al momento de la confirmación, de modo que las órdenes históricas sigan siendo legibles aunque el catálogo cambie posteriormente.

## Costo aceptado
- Pueden producirse fallas de red.
- No existe una transacción distribuida; el flujo de creación de una orden necesita compensación si la persistencia local falla después de reservar stock.
- Deben operarse y probarse dos bases de datos y dos servicios.

## Consecuencias
- Cada servicio tiene su propia base de datos PostgreSQL y credenciales dedicadas.
- Sales no puede consultar tablas de Inventory.
- Las fallas de integración forman parte del comportamiento de la API y deben medirse.
- Si el negocio necesita precios en el futuro, su responsabilidad deberá decidirse explícitamente en lugar de añadir tablas compartidas.
