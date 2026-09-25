import { Controller, Get, Module } from '@nestjs/common';
import { Public } from '../auth/api-key.guard.js';

@Controller('v1/health')
class HealthController {
  @Get()
  @Public()
  getHealth(): { status: 'ok'; service: 'sales-api' } {
    return { status: 'ok', service: 'sales-api' };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}