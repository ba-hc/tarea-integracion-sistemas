import { Logger } from '@nestjs/common';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    new Logger('Bootstrap').error(`invalid configuration: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const app = await createApp(config);
await app.listen(config.port, config.host);
new Logger('Bootstrap').log('payments api listening', {
  address: `${config.host}:${config.port}`,
  gateway: config.gateway.baseUrl,
  gatewayTimeoutMs: config.gateway.timeoutMs,
  circuitBreaker: config.circuitBreaker.enabled,
  bulkhead: config.bulkhead.enabled ? config.bulkhead.maxConcurrent : false,
});
