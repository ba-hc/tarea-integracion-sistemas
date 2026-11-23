import { Logger } from '@nestjs/common';

Logger.overrideLogger(process.env.TEST_LOGS === 'true' ? ['log', 'warn', 'error'] : false);
