import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',').map((origin) => origin.trim()) ?? true,
    credentials: true,
  });
  await app.listen(process.env.API_PORT ?? 3000, process.env.API_HOST ?? '0.0.0.0');
}
bootstrap();
