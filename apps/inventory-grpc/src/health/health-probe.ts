// Cliente mínimo de grpc.health.v1 para el HEALTHCHECK de Docker:
//   node dist/src/health/health-probe.js   -> exit 0 si SERVING, 1 en otro caso
// Consulta el servidor local en GRPC_PORT (por defecto 50051).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { protoPath } from 'grpc-health-check';

const port = process.env.GRPC_PORT?.trim() || '50051';
const definition = protoLoader.loadSync(protoPath, { keepCase: true, enums: String, defaults: true });
const { grpc: grpcPackage } = grpc.loadPackageDefinition(definition) as any;
const client = new grpcPackage.health.v1.Health(`127.0.0.1:${port}`, grpc.credentials.createInsecure());

client.Check({ service: '' }, { deadline: Date.now() + 2_000 }, (error: grpc.ServiceError | null, response: any) => {
  client.close();
  if (error) {
    console.error(`health check failed: ${error.code} ${error.details}`);
    process.exit(1);
  }
  console.log(`health: ${response.status}`);
  process.exit(response.status === 'SERVING' ? 0 : 1);
});
