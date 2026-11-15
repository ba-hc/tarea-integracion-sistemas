import { pathToFileURL } from 'node:url';
import { signDemoToken } from '../auth/sign-demo-token.js';
import {
  ConfigError,
  loadJwtConfig,
  type Role,
} from '../config/gateway-config.js';

export interface CliOptions {
  readonly sub: string;
  readonly role: Role;
  readonly ttlMinutes: number;
}

export class CliUsageError extends Error {}

const USAGE = 'usage: npm run token -- --sub <subject> --role <reader|operator> [--ttl <minutes>]';

function optionValue(argv: readonly string[], index: number, name: string): { value: string; next: number } {
  const argument = argv[index];
  if (argument === undefined) throw new CliUsageError(`${name} is required`);
  const equals = argument.indexOf('=');
  if (equals !== -1) {
    const value = argument.slice(equals + 1);
    if (!value) throw new CliUsageError(`${name} is required`);
    return { value, next: index + 1 };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError(`${name} is required`);
  }
  return { value, next: index + 2 };
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let sub: string | undefined;
  let role: string | undefined;
  let ttlMinutes = 15;

  for (let index = 0; index < argv.length;) {
    const argument = argv[index];
    if (argument === undefined) break;
    if (argument === '--sub' || argument.startsWith('--sub=')) {
      const parsed = optionValue(argv, index, '--sub');
      sub = parsed.value;
      index = parsed.next;
      continue;
    }
    if (argument === '--role' || argument.startsWith('--role=')) {
      const parsed = optionValue(argv, index, '--role');
      role = parsed.value;
      index = parsed.next;
      continue;
    }
    if (argument === '--ttl' || argument.startsWith('--ttl=')) {
      const parsed = optionValue(argv, index, '--ttl');
      if (!/^[0-9]+$/.test(parsed.value)) {
        throw new CliUsageError('--ttl must be a positive integer');
      }
      const value = Number(parsed.value);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new CliUsageError('--ttl must be a positive integer');
      }
      ttlMinutes = value;
      index = parsed.next;
      continue;
    }
    throw new CliUsageError('unknown argument');
  }

  if (!sub || !sub.trim()) throw new CliUsageError('--sub is required');
  if (role !== 'reader' && role !== 'operator') {
    throw new CliUsageError('--role must be reader or operator');
  }
  return { sub: sub.trim(), role, ttlMinutes };
}

export interface CliOutput {
  write(chunk: string): unknown;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  stdout: CliOutput = process.stdout,
  stderr: CliOutput = process.stderr,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const options = parseArgs(argv);
    const config = loadJwtConfig(env);
    const token = await signDemoToken(config, options);
    stdout.write(`${token}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr.write(`${error.message}\n${USAGE}\n`);
      return 2;
    }
    if (error instanceof ConfigError) {
      stderr.write(`invalid configuration: ${error.message}\n`);
      return 1;
    }
    stderr.write('could not issue token\n');
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await main();
}
