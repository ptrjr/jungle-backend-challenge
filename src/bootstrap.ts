import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ErrorFilter } from './http/error.filter';

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: new ConsoleLogger({ json: true }), bodyParser: true });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  return app;
}
