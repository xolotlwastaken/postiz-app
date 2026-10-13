import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { PublicApiModule } from '@gitroom/backend/public-api/public.api.module';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { TemporalRegisterMissingSearchAttributesModule } from '@gitroom/nestjs-libraries/temporal/temporal.register';
import { InfiniteWorkflowRegisterModule } from '@gitroom/nestjs-libraries/temporal/infinite.workflow.register';
import { ThrottlerBehindProxyGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { SwayCueWorkspaceController } from './workspace.controller';

// No dashboard API, registration, local login, billing, chat or MCP listener.
@Module({
  imports: [
    SentryModule.forRoot(), DatabaseModule, PublicApiModule,
    getTemporalModule(false), TemporalRegisterMissingSearchAttributesModule,
    InfiniteWorkflowRegisterModule,
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 3600000, limit: Number(process.env.API_LIMIT || 900) }],
      storage: new ThrottlerStorageRedisService(ioRedis),
    }),
  ],
  controllers: [SwayCueWorkspaceController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard }],
})
export class HeadlessModule {}
