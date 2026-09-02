import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./shared/realtime/redis-io.adapter";
import { AllExceptionsFilter } from "./shared/errors/all-exceptions.filter";
import { initSentry } from "./shared/monitoring/sentry";
import { requestLoggingMiddleware } from "./shared/monitoring/request-logging.middleware";
import { bootstrapAppRoleIfRequested } from "./shared/prisma/bootstrap-app-role";
import { runDbMigrationsIfRequested } from "./shared/prisma/run-db-migrations";

async function bootstrap() {
  initSentry();
  await bootstrapAppRoleIfRequested();
  await runDbMigrationsIfRequested();

  const app = await NestFactory.create(AppModule);

  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  app.use(requestLoggingMiddleware);
  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean),
    credentials: true,
  });
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  // Bind explicitly to all interfaces, IPv4 and IPv6. Some hosts (Fly.io)
  // route external traffic over IPv4 but internal machine-to-machine
  // traffic (the private 6PN network other services use to reach this API)
  // exclusively over IPv6 — binding to "0.0.0.0" alone leaves that IPv6
  // path unreachable ("connection refused" from sibling services) even
  // though the public URL works fine.
  await app.listen(port, "::");
}

void bootstrap();
