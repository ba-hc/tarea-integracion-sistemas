import { defineConfig } from 'prisma/config';

// Carga apps/inventory-grpc/.env si existe (desarrollo local). En Docker las
// variables llegan por el entorno del contenedor y el archivo no existe.
try {
  process.loadEnvFile();
} catch {
  // sin .env: se usan sólo las variables del entorno
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // `prisma generate` no necesita conexión, por eso no se exige aquí;
    // `migrate` y `db seed` fallan con un error claro si falta.
    url: process.env.DATABASE_URL,
  },
});
