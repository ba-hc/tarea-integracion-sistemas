import { describe, expect, it } from 'vitest';
import { JwtVerifier } from '../auth/jwt-verifier.js';
import { CliUsageError, main, parseArgs, type CliOutput } from './token.js';

class CaptureOutput implements CliOutput {
  value = '';

  write(chunk: string): boolean {
    this.value += chunk;
    return true;
  }
}

describe('token CLI', () => {
  it('parses required and optional arguments', () => {
    expect(parseArgs(['--sub', 'demo', '--role', 'reader'])).toEqual({
      sub: 'demo',
      role: 'reader',
      ttlMinutes: 15,
    });
    expect(parseArgs(['--sub=demo', '--role=operator', '--ttl=5'])).toEqual({
      sub: 'demo',
      role: 'operator',
      ttlMinutes: 5,
    });
  });

  it.each([
    [['--role', 'reader'], '--sub is required'],
    [['--sub', 'demo'], '--role must be reader or operator'],
    [['--sub', 'demo', '--role', 'admin'], '--role must be reader or operator'],
    [['--sub', 'demo', '--role', 'reader', '--ttl', '0'], '--ttl must be a positive integer'],
    [['--sub', 'demo', '--role', 'reader', '--unknown'], 'unknown argument'],
  ])('rejects invalid arguments %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrowError(CliUsageError);
    expect(() => parseArgs(argv)).toThrowError(message);
  });

  it('issues a token using only JWT configuration and never writes the secret', async () => {
    const stdout = new CaptureOutput();
    const stderr = new CaptureOutput();
    const secret = 'cli-secret-with-at-least-32-bytes!!';
    const code = await main(
      ['--sub', 'cli-demo', '--role', 'reader'],
      { GATEWAY_JWT_SECRET: secret },
      stdout,
      stderr,
    );
    expect(code).toBe(0);
    expect(stderr.value).toBe('');
    expect(stdout.value.trim().split('.')).toHaveLength(3);
    expect(stdout.value).not.toContain(secret);

    const verifier = new JwtVerifier({
      secret,
      issuer: 'repuestossur-demo',
      audience: 'repuestossur-gateway',
    });
    await expect(verifier.verify(stdout.value.trim())).resolves.toMatchObject({
      sub: 'cli-demo',
      role: 'reader',
    });
  });

  it('returns a safe error for invalid configuration', async () => {
    const stdout = new CaptureOutput();
    const stderr = new CaptureOutput();
    const code = await main(
      ['--sub', 'cli-demo', '--role', 'reader'],
      { GATEWAY_JWT_SECRET: 'short-secret' },
      stdout,
      stderr,
    );
    expect(code).toBe(1);
    expect(stdout.value).toBe('');
    expect(stderr.value).toContain('GATEWAY_JWT_SECRET must be at least 32 bytes');
    expect(stderr.value).not.toContain('short-secret');
  });

  it('returns usage status for invalid arguments', async () => {
    const stdout = new CaptureOutput();
    const stderr = new CaptureOutput();
    const code = await main([], {}, stdout, stderr);
    expect(code).toBe(2);
    expect(stdout.value).toBe('');
    expect(stderr.value).toContain('--sub is required');
  });

  it('does not echo an unknown argument value in the error output', async () => {
    const stdout = new CaptureOutput();
    const stderr = new CaptureOutput();
    const code = await main(
      ['--sub', 'cli-demo', '--role', 'reader', '--secret=do-not-leak'],
      {},
      stdout,
      stderr,
    );
    expect(code).toBe(2);
    expect(stdout.value).toBe('');
    expect(stderr.value).toContain('unknown argument');
    expect(stderr.value).not.toContain('do-not-leak');
  });
});
