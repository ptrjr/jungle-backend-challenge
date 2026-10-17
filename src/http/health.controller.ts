import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SqsService } from '../messaging/sqs.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(DataSource) private readonly source: DataSource, @Inject(SqsService) private readonly sqs: SqsService) {}
  @Get('live')
  live() { return { status: 'ok' }; }
  @Get('ready')
  async ready() {
    try { await Promise.all([this.source.query('SELECT 1'), this.sqs.ready()]); }
    catch { throw new ServiceUnavailableException({ code: 'DEPENDENCIES_UNAVAILABLE' }); }
    return { status: 'ok', dependencies: { postgres: 'up', sqs: 'up' } };
  }
}
