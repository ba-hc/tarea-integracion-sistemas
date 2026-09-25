import { resolve } from 'node:path';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  databaseUrl: string;
  grpcHost: string;
  grpcPort: number;
  protoPath: string;
}

// Relativa al directorio del servicio (apps/inventory-grpc), que es el cwd
// tanto con `npm run` como en el contenedor.
const DEFAULT_PROTO_PATH = '../../contracts/grpc/repuestossur/inventory/v1/inventory.proto';

export class ConfigError extends Error {}

/** Lee y valida la configuración. Falla al arrancar en vez de a mitad de una llamada. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL es obligatoria');
  }

  const rawPort = env.GRPC_PORT?.trim() || '50051';
  const grpcPort = Number(rawPort);
  if (!Number.isInteger(grpcPort) || grpcPort < 1 || grpcPort > 65535) {
    throw new ConfigError(`GRPC_PORT inválido: "${rawPort}"`);
  }

  return {
    databaseUrl,
    grpcHost: env.GRPC_HOST?.trim() || '0.0.0.0',
    grpcPort,
    protoPath: resolve(env.INVENTORY_PROTO_PATH?.trim() || DEFAULT_PROTO_PATH),
  };
}
