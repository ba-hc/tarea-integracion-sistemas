# ADR-002 - REST hacia el exterior y gRPC unary hacia el interior

**Estado:** Aceptada

## Contexto

Sales ofrece una API pública para clientes y órdenes; Inventory es un servicio interno de alto uso al que Sales consulta y envía mutaciones de stock. La elección debe equilibrar interoperabilidad del borde, contratos, operación y rendimiento. REST/JSON y gRPC no tienen una ventaja universal de rendimiento: el tamaño del mensaje, el runtime, la red y el trabajo de aplicación cambian el resultado.

## Alternativas consideradas

1. **REST/JSON en ambos límites.** Interoperable y fácil de inspeccionar; cada consumidor implementa el contrato HTTP/JSON y la integración interna queda sin stubs generados desde el `.proto`.
2. **gRPC en ambos límites.** Contratos de mensajes y servicios con generación de código, transporte binario y streaming; el gRPC nativo requiere clientes gRPC compatibles y no es una interfaz directa para `fetch` en navegadores convencionales.
3. **REST público + gRPC interno.** Mantiene HTTP/JSON en el borde y un contrato RPC tipado y versionado entre Sales e Inventory.

## Comparación técnica

| Factor | REST/JSON | gRPC unary/Protobuf | Impacto en RepuestosSur |
|---|---|---|---|
| Rendimiento | JSON textual; el coste depende del tamaño del documento y del runtime. | Mensajes Protobuf binarios; los resultados publicados favorecen gRPC al crecer los payloads, pero no establecen una ventaja universal [1]. | Evidencia de apoyo, no una promesa de latencia para este stack. Los RPC actuales envían solicitudes pequeñas y también esperan a PostgreSQL. |
| Tipado | OpenAPI describe una interfaz HTTP independiente del lenguaje y puede alimentar documentación, validadores y generadores de clientes [2]. | `.proto` define mensajes y servicios; Protobuf genera bindings tipados para varios lenguajes [3]. | OpenAPI fija el contrato público; el `.proto` genera el contrato compartido Sales↔Inventory. |
| Interoperabilidad | HTTP/JSON se consume directamente con navegadores, `fetch`, `curl` y clientes HTTP comunes. | Un navegador suele necesitar gRPC-Web y un proxy compatible; no consume el protocolo gRPC nativo directamente [4]. | REST en la frontera pública; gRPC queda en la red interna. |
| Caché | HTTP estandariza cachés, claves y directivas; respuestas GET pueden reutilizarse cuando método, estado y cabeceras lo permiten [5]. No toda respuesta REST es cacheable. | Las llamadas gRPC usan HTTP/2 POST y mensajes con framing gRPC [6]; no obtienen por defecto la reutilización transparente de respuestas GET de una caché HTTP convencional. | REST es la interfaz natural para lecturas públicas que eventualmente requieran caché; no se añade caché al sistema en esta decisión. |
| Depuración manual | `curl`, herramientas HTTP y documentación OpenAPI permiten inspeccionar solicitudes y respuestas sin un cliente específico. | Los mensajes binarios son menos legibles; reflection expone servicios y tipos a herramientas como `grpcurl` [7]. | Reflection habilita diagnóstico interno; no se expone gRPC a los clientes públicos. |

## Evidencia de rendimiento y límites

Berg y Redi compararon servidores REST/JSON y gRPC/Protobuf en Java, Python y Rust mediante una red local de 1 Gbit/s. En la Tabla 4.2, los tamaños serializados JSON/Protobuf fueron 646/556 bytes (S), 49.945/22.080 bytes (M) y 500.820/220.410 bytes (L): Protobuf ocupó aproximadamente 14 % menos en S y 56 % menos en M y L. En la Figura 5.1, el servidor Java atendió 4.700/4.700 solicitudes por segundo en XS, 4.000/4.300 en S, 1.700/2.300 en M y 240/500 en L (REST/gRPC). La prueba L quedó limitada por el enlace de 1 Gbit/s [1].

El estudio usó servidores sintéticos sin lógica de negocio, base de datos ni logging; por eso sus tasas no predicen el rendimiento de Sales/Inventory con NestJS, gRPC-js y PostgreSQL. Los resultados muestran un efecto dependiente del payload y del entorno: empate con respuesta vacía, diferencias pequeñas en S y ventaja mayor de gRPC con mensajes más grandes en esa configuración. Esta ADR no afirma una mejora porcentual para RepuestosSur; habría que medir el stack y las solicitudes reales para sostenerla.

## Decisión

Exponer Sales mediante REST/JSON bajo `/v1`; usar RPC unary gRPC con Protocol Buffers para las llamadas de Sales a Inventory. Los RPC requeridos son solicitud/respuesta, por lo que streaming agregaría complejidad sin un caso de uso presente.

## Costos y consecuencias

- El sistema mantiene dos protocolos y toolchains.
- El equipo debe comprender semántica HTTP y estados gRPC.
- Sales traduce los estados gRPC a errores REST estables según la operación; la traducción se documenta en `docs/architecture/ERROR-MAPPING.md`.
- El contrato REST es `contracts/rest/openapi.yaml`; el gRPC es `contracts/grpc/repuestossur/inventory/v1/inventory.proto`.
- Los RPC con streaming no están permitidos en v1.

## Fuentes

1. Johan Berg y Daniel Mebrahtu Redi, “Benchmarking the Request Throughput of Conventional API Calls and gRPC: A Comparative Study of REST and gRPC”, KTH, 2023, Tabla 4.2, pp. 24–25; Figura 5.1 y análisis, pp. 35–40. [PDF](https://www.diva-portal.org/smash/get/diva2%3A1792957/FULLTEXT01.pdf).
2. OpenAPI Initiative, *OpenAPI Specification 3.1.2*, propósito, generación de documentación y clientes: https://spec.openapis.org/oas/v3.1.2.html.
3. Google, *Protocol Buffers Overview*, serialización, bindings generados e interoperabilidad de lenguajes: https://protobuf.dev/overview/.
4. gRPC, *gRPC-Web Basics*, cliente de navegador, generación de stubs y proxy Envoy: https://grpc.io/docs/platforms/web/basics/.
5. IETF, RFC 9111, *HTTP Caching*, semántica de almacenamiento, reutilización y validación: https://www.rfc-editor.org/rfc/rfc9111.
6. gRPC, *gRPC over HTTP/2 Protocol*, método POST, `application/grpc` y mensajes length-prefixed: https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md.
7. gRPC, *Reflection*, introspección usada por `grpcurl` y limitaciones de legibilidad del transporte binario: https://grpc.io/docs/guides/reflection/.
