# ADR-002 - REST hacia el exterior y gRPC unary hacia el interior

**Estado:** Aceptada

## Contexto
La capacidad pública de Sales puede ser utilizada por personal de la organización y por un futuro portal web, mientras que Inventory es una dependencia interna de alta frecuencia utilizada únicamente por Sales. El encargo solicita explícitamente REST hacia el exterior y gRPC hacia el interior, pero la elección igualmente debe justificarse.

## Alternativas consideradas
1. **REST/JSON en ambos límites.** Es simple de operar y fácil de inspeccionar, pero duplica preocupaciones propias de una API HTTP en la ruta interna y ofrece garantías de esquema y generación de código más débiles que el contrato protobuf seleccionado.
2. **gRPC en ambos límites.** Entrega contratos fuertes y transporte binario eficiente en todas partes, pero la interoperabilidad con navegadores y clientes públicos y la depuración manual son menos convenientes en el borde público.
3. **REST público + gRPC interno.** Usa una interfaz HTTP/JSON ampliamente interoperable en el borde y una interfaz RPC protobuf fuertemente tipada entre servicios.

## Decisión
Exponer Sales mediante una API REST/JSON versionada bajo `/v1`. Usar gRPC unary con Protocol Buffers para la comunicación entre Sales e Inventory.

## Justificación
Los consumidores públicos se benefician de la semántica HTTP estándar, del tooling de OpenAPI y de una interoperabilidad sencilla con navegadores y herramientas. Internamente, el archivo `.proto` es un contrato compacto e independiente del lenguaje que permite generar clientes y servidores. Todas las operaciones requeridas de Inventory siguen un patrón solicitud/respuesta, por lo que RPC unary es suficiente; el streaming añadiría complejidad sin un caso de uso real.

## Costo aceptado
- El sistema mantiene dos stacks de protocolos y herramientas.
- Quienes desarrollan el sistema deben comprender tanto la semántica de estados HTTP como la de estados gRPC.
- La traducción de errores en el límite de Sales debe ser explícita.

## Consecuencias
- Contrato REST: `contracts/rest/openapi.yaml`.
- Contrato gRPC: `contracts/grpc/repuestossur/inventory/v1/inventory.proto`.
- Los RPC con streaming no están permitidos en v1.
- Sales es responsable de traducir las fallas gRPC a errores HTTP públicos estables.
