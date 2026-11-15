import { Module, type DynamicModule } from '@nestjs/common';
import { BffService } from './bff.service.js';
import { BFF_CONFIG, BFF_LOGGER, type BffConfig } from './config/bff-config.js';
import { ConsoleBffLogger, type BffLoggerPort } from './logging/bff-logger.js';
import { DispatchClient } from './sources/dispatch-client.js';
import { PaymentsClient } from './sources/payments-client.js';
import { DISPATCH_SOURCE, PAYMENTS_SOURCE } from './sources/tokens.js';
import { SummaryService } from './summary/summary.service.js';

export interface BffOverrides {
  readonly logger?: BffLoggerPort;
}

@Module({})
export class BffModule {
  static register(config: BffConfig, overrides: BffOverrides = {}): DynamicModule {
    return {
      module: BffModule,
      providers: [
        { provide: BFF_CONFIG, useValue: config },
        {
          provide: BFF_LOGGER,
          useValue: overrides.logger ?? new ConsoleBffLogger(),
        },
        PaymentsClient,
        DispatchClient,
        { provide: PAYMENTS_SOURCE, useExisting: PaymentsClient },
        { provide: DISPATCH_SOURCE, useExisting: DispatchClient },
        SummaryService,
        BffService,
      ],
    };
  }
}
