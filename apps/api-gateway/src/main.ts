import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { createGatewayApp } from './app.js';
import { ConfigError, loadGatewayConfig } from './config/gateway-config.js';

export async function bootstrap(): Promise<void> {
  try {
    const config = loadGatewayConfig();
    const app = await createGatewayApp(config);
    app.enableShutdownHooks();
    await app.listen(config.port, config.host);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`invalid configuration: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await bootstrap();
}
