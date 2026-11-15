import { Module, type DynamicModule } from '@nestjs/common';
import { JwtVerifier } from './auth/jwt-verifier.js';
import {
  GATEWAY_CLOCK,
  GATEWAY_CONFIG,
  GATEWAY_LOGGER,
  type GatewayConfig,
} from './config/gateway-config.js';
import { GatewayService } from './gateway.service.js';
import {
  ConsoleGatewayLogger,
  type GatewayLoggerPort,
} from './logging/gateway-logger.js';
import { ProxyClient } from './proxy/proxy-client.js';
import { RateLimiter } from './rate-limit/rate-limiter.js';

export interface GatewayOverrides {
  readonly clock?: () => number;
  readonly logger?: GatewayLoggerPort;
}

@Module({})
export class GatewayModule {
  static register(config: GatewayConfig, overrides: GatewayOverrides = {}): DynamicModule {
    return {
      module: GatewayModule,
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        { provide: GATEWAY_CLOCK, useValue: overrides.clock ?? Date.now },
        {
          provide: GATEWAY_LOGGER,
          useValue: overrides.logger ?? new ConsoleGatewayLogger(),
        },
        JwtVerifier,
        {
          provide: RateLimiter,
          useFactory: (gatewayConfig: GatewayConfig, clock: () => number) => new RateLimiter(
            gatewayConfig.rateLimitWindowMs,
            gatewayConfig.rateLimitMaxRequests,
            gatewayConfig.rateLimitMaxIdentities,
            clock,
          ),
          inject: [GATEWAY_CONFIG, GATEWAY_CLOCK],
        },
        ProxyClient,
        GatewayService,
      ],
    };
  }
}
