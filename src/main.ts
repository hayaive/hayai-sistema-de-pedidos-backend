import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { AppConfig } from './config/app-config';

async function bootstrap() {
  const log = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const cfg = app.get(AppConfig);

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      // Lo que no está en el DTO no llega al servicio. Es lo que hace que `stock`
      // o `saleNext` no puedan colarse en un parche por venir en el JSON.
      whitelist: true,
      transform: true,
      // Los query params llegan como string: sin esto, `?since=0` no se convierte.
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  /**
   * CORS. El frontend vive en otro dominio, así que sin esto no hay aplicación.
   *
   * `localhost` se acepta en **cualquier puerto** porque en desarrollo el puerto
   * cambia (Vite, TanStack Start, un `serve` suelto) y mantener una lista de
   * puertos a mano sólo produce "me da CORS y no sé por qué".
   */
  const origins = cfg.corsOrigins;
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Sin `Origin` es una petición que no viene de un navegador (curl, un healthcheck).
      if (!origin) return callback(null, true);

      const allowed =
        origins.includes(origin) ||
        origins.some((pattern) => matchesLocalhost(pattern, origin)) ||
        origins.includes('*');

      // No se lanza un error: un origen no permitido simplemente no recibe las
      // cabeceras de CORS. Lanzar produciría un 500 que parece una caída del server.
      callback(null, allowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'If-Match', 'X-Device-Id'],
    exposedHeaders: ['ETag'],
    maxAge: 86_400,
  });

  // Railway inyecta PORT, y hay que escuchar en 0.0.0.0 para que su proxy llegue:
  // con el default de Node (localhost) el healthcheck falla y el deploy se cae.
  const port = cfg.port;
  await app.listen(port, '0.0.0.0');

  log.log(`Escuchando en http://0.0.0.0:${port}/api/v1 (${cfg.nodeEnv})`);
  log.log(`CORS permitido para: ${origins.join(', ')}`);
}

/**
 * `http://localhost` en la lista permite cualquier puerto de localhost (y de
 * 127.0.0.1). Un patrón con puerto explícito exige ese puerto.
 */
function matchesLocalhost(pattern: string, origin: string): boolean {
  if (pattern !== 'http://localhost' && pattern !== 'http://localhost:*') return false;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

void bootstrap();
