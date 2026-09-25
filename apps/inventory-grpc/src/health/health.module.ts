import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [PrismaModule],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
