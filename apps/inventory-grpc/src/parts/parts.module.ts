import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PartsController } from './parts.controller.js';
import { PartsService } from './parts.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [PartsController],
  providers: [PartsService],
})
export class PartsModule {}
