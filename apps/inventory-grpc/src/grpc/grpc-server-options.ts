import type { Server } from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { Transport, type GrpcOptions } from '@nestjs/microservices';
import { protoPath as healthProtoPath, type HealthImplementation } from 'grpc-health-check';
import type { AppConfig } from '../config/app-config.js';
import { INVENTORY_PACKAGE, INVENTORY_PROTO_LOADER_OPTIONS } from './inventory.proto-types.js';

export interface GrpcServerExtras {
  /** grpc.health.v1.Health, siempre registrado. */
  health: HealthImplementation;
}

export function grpcServerOptions(config: AppConfig, extras: GrpcServerExtras): GrpcOptions {
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
      // Servicios estándar de gRPC que viven junto a InventoryService en el
      // mismo servidor. No forman parte del contrato de negocio.
      onLoadPackageDefinition: (packageDefinition: protoLoader.PackageDefinition, server: Server) => {
        extras.health.addToServer(server);
        if (config.reflectionEnabled) {
          const healthDefinition = protoLoader.loadSync(healthProtoPath, INVENTORY_PROTO_LOADER_OPTIONS);
          new ReflectionService({ ...packageDefinition, ...healthDefinition }).addToServer(server);
        }
      },
    },
  };
}
