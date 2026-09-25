import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile();
} catch {
  // Compose or the host environment may provide the configuration directly.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});