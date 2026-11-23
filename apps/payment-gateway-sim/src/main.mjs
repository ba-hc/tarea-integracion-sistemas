import { createServer } from 'node:http';
import { configFromEnv, createSimulator } from './simulator.mjs';

const port = Number(process.env.PORT ?? 3010);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');

const simulator = createSimulator(configFromEnv());
const server = createServer((request, response) => void simulator.handle(request, response));
server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(JSON.stringify({ msg: 'payment gateway simulator listening', port, ...simulator.config() }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    simulator.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
