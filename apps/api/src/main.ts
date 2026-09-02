import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./shared/realtime/redis-io.adapter";
import { AllExceptionsFilter } from "./shared/errors/all-exceptions.filter";
import { initSentry } from "./shared/monitoring/sentry";
import { requestLoggingMiddleware } from "./shared/monitoring/request-logging.middleware";
import { bootstrapAppRoleIfRequested } from "./shared/prisma/bootstrap-app-role";
import { repairLegacyEmailsIfRequested } from "./shared/prisma/repair-legacy-emails";
import { runDbMigrationsIfRequested } from "./shared/prisma/run-db-migrations";

async function bootstrap() {
  initSentry();
  await bootstrapAppRoleIfRequested();
  await runDbMigrationsIfRequested();
  await repairLegacyEmailsIfRequested();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  app.use(requestLoggingMiddleware);
  // Render terminates TLS at its edge and nginx (dashboard/POS/KDS/ordering
  // proxies) adds one more hop, so Express must honor X-Forwarded-For to see
  // the real client IP. Without this, EVERY dashboard user shares the
  // proxy's internal IP as far as the ThrottlerGuard is concerned — one
  // busy restaurant could burn the whole login rate budget for everyone and
  // the dashboard silently 429s ("button does nothing" in production).
  // One trusted hop (Render's edge) + the proxies set X-Forwarded-For
  // correctly; a fixed count (not `true`) keeps a malicious client from
  // spoofing an IP chain to dodge rate limits.
  app.set("trust proxy", 2);
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
