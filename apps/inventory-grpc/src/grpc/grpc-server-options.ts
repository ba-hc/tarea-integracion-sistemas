import { Transport, type GrpcOptions } from '@nestjs/microservices';
import type { AppConfig } from '../config/app-config.js';
import { INVENTORY_PACKAGE, INVENTORY_PROTO_LOADER_OPTIONS } from './inventory.proto-types.js';

export function grpcServerOptions(config: AppConfig): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      package: INVENTORY_PACKAGE,
      // Se carga el .proto congelado en tiempo de ejecución, sin copiarlo ni
      // generar código: lo que se sirve es exactamente el contrato.
      protoPath: config.protoPath,
      url: `${config.grpcHost}:${config.grpcPort}`,
      loader: INVENTORY_PROTO_LOADER_OPTIONS,
      // Al cerrar, deja terminar las llamadas en curso en vez de cortarlas.
      gracefulShutdown: true,
    },
  };
}
