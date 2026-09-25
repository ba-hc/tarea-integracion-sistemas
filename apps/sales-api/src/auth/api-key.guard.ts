import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SALES_CONFIG, type ApiKeyRole, type SalesConfig } from '../config/app-config.js';
import { ApiError } from '../common/api-error.js';

const PUBLIC_ROUTE = 'sales:public';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

interface AuthenticatedRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  authRole?: ApiKeyRole;
}

function constantTimeEqual(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SALES_CONFIG) private readonly config: SalesConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawKey = request.headers['x-api-key'];
    const key = typeof rawKey === 'string' ? rawKey : '';
    if (!key) throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key');

    const isOperator = constantTimeEqual(key, this.config.apiKeyOperator);
    const isReader = constantTimeEqual(key, this.config.apiKeyReader);
    if (!isOperator && !isReader) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key');
    }
    const role: ApiKeyRole = isOperator ? 'operator' : 'reader';
    request.authRole = role;

    const allowedRoles: readonly ApiKeyRole[] = request.method === 'GET' ? ['reader', 'operator'] : ['operator'];
    if (!allowedRoles.includes(role)) {
      throw new ApiError(403, 'FORBIDDEN', 'The API key does not have permission for this operation');
    }
    return true;
  }
}