import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import type { SalesConfig } from '../config/app-config.js';
import { ApiKeyGuard, Public } from './api-key.guard.js';

const config: SalesConfig = {
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://sales:password@localhost/sales',
  apiKeyReader: 'reader-secret-test',
  apiKeyOperator: 'operator-secret-test',
  inventoryGrpcUrl: 'localhost:50051',
  inventoryRpcDeadlineMs: 800,
  inventoryProtoPath: '/contract/inventory.proto',
};

function executionContext(method: string, key?: string, handler: () => void = () => undefined): ExecutionContext {
  const request = { method, headers: { 'x-api-key': key } };
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function captureError(action: () => boolean): ApiError {
  try {
    action();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected authorization to fail');
}

describe('ApiKeyGuard', () => {
  const guard = new ApiKeyGuard(new Reflector(), config);

  it('allows reader GET and operator POST', () => {
    expect(guard.canActivate(executionContext('GET', config.apiKeyReader))).toBe(true);
    expect(guard.canActivate(executionContext('POST', config.apiKeyOperator))).toBe(true);
  });

  it('rejects missing and invalid keys with 401', () => {
    expect(captureError(() => guard.canActivate(executionContext('GET'))).getStatus()).toBe(401);
    expect(captureError(() => guard.canActivate(executionContext('GET', 'wrong'))).code).toBe('UNAUTHORIZED');
  });

  it('rejects reader writes with 403', () => {
    const error = captureError(() => guard.canActivate(executionContext('POST', config.apiKeyReader)));
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('bypasses credentials only for an explicitly public route', () => {
    class HealthController {
      @Public()
      health(): void {}
    }
    const handler = HealthController.prototype.health;
    expect(guard.canActivate(executionContext('GET', undefined, handler))).toBe(true);
  });
});