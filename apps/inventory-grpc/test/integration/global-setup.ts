import { execFileSync } from 'node:child_process';
import { testDatabaseUrl } from './test-database.js';

/** Aplica las migraciones reales (las mismas que usa el contenedor) a la base de pruebas. */
export default function setup(): void {
  const databaseUrl = testDatabaseUrl();
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}
