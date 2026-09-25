// Punto de entrada del seed.
//   npm run db:seed                 -> inserta las piezas que falten
//   npm run db:seed -- --reset      -> además restaura stock/sku/nombre iniciales
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedParts, type SeedMode } from './seed-parts.js';

try {
  process.loadEnvFile();
} catch {
  // sin .env: se usan sólo las variables del entorno
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL no está definida');
  process.exit(1);
}

const mode: SeedMode = process.argv.includes('--reset') ? 'reset' : 'insert-missing';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

try {
  const count = await seedParts(prisma, mode);
  console.log(`seed (${mode}): ${count} piezas escritas`);
} catch (error) {
  console.error('seed falló', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
