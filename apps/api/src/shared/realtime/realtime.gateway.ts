import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";

import type { AccessTokenPayload } from "../../modules/identity/token.service";
import { PlatformPrismaService } from "../prisma/platform-prisma.service";
import { PrismaService } from "../prisma/prisma.service";
import { rtRooms } from "./rooms";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SocketContext {
  /** undefined = guest connection (customer ordering app). */
  userId?: string;
  tenantId?: string;
  permissions: Set<string>;
}

interface SubscribePayload {
  channel: "orders" | "kitchen" | "catalog" | "order";
  branchId?: string;
  orderId?: string;
}

/**
 * Realtime gateway (Socket.io; Redis adapter attached in main.ts when
 * REDIS_URL is configured).
 *
 * Security model:
 * - A valid access JWT (handshake.auth.token) yields a staff context.
 *   Connections WITHOUT a token are guests: they may only join per-order
 *   rooms (the order UUID is the capability) — every staff channel is denied.
 * - Staff rooms are derived from the token's tenant — never from client input.
 * - `orders` needs orders.view; `kitchen` needs kitchen.view and the branch
 *   must belong to the tenant (verified through the RLS-scoped client).
 */
@WebSocketGateway({
  cors: { origin: (process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean) },
})
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly platformDb: PlatformPrismaService,
  ) {}

  handleConnection(socket: Socket): void {
    const token = socket.handshake.auth?.token as string | undefined;
    const guest: SocketContext = { permissions: new Set() };
    if (!token) {
      socket.data.ctx = guest;
      return;
    }
    try {
      const payload = this.jwt.verify<AccessTokenPayload>(token);
      if (payload.type !== "access" || !payload.sub) {
        socket.data.ctx = guest;
        return;
      }
      socket.data.ctx = {
        userId: payload.sub,
        tenantId: payload.tenant_id,
        permissions: new Set(payload.permissions ?? []),
      } satisfies SocketContext;
    } catch {
      // Invalid/expired token -> guest privileges only.
      socket.data.ctx = guest;
    }
  }

  @SubscribeMessage("subscribe")
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: SubscribePayload,
  ): Promise<{ ok: boolean; room?: string; error?: string }> {
    const ctx = socket.data.ctx as SocketContext | undefined;

    // Guest channel: follow one order by its UUID capability.
    if (body?.channel === "order") {
      if (!body.orderId || !UUID_RE.test(body.orderId)) {
        return { ok: false, error: "orderId required" };
      }
      const order = await this.platformDb.order.findFirst({
        where: { id: body.orderId, deletedAt: null },
        select: { id: true },
      });
      if (!order) {
        return { ok: false, error: "order not found" };
      }
      const room = rtRooms.order(order.id);
      await socket.join(room);
      return { ok: true, room };
    }

    // Staff channels require an authenticated tenant context.
    if (!ctx?.userId || !ctx.tenantId) {
      return { ok: false, error: "unauthorized" };
    }

    if (body?.channel === "orders") {
      if (!ctx.permissions.has("orders.view")) {
        return { ok: false, error: "forbidden" };
      }
      const room = rtRooms.tenantOrders(ctx.tenantId);
      await socket.join(room);
      return { ok: true, room };
    }

    if (body?.channel === "kitchen") {
      if (!ctx.permissions.has("kitchen.view")) {
        return { ok: false, error: "forbidden" };
      }
      if (!body.branchId) {
        return { ok: false, error: "branchId required" };
      }
      const branch = await this.prisma
        .forTenant(ctx.tenantId)
        .branch.findFirst({ where: { id: body.branchId, deletedAt: null } });
      if (!branch) {
        return { ok: false, error: "branch not found" };
      }
      const room = rtRooms.branchKitchen(body.branchId);
      await socket.join(room);
      return { ok: true, room };
    }

    if (body?.channel === "catalog") {
      if (!ctx.permissions.has("menu.view")) {
        return { ok: false, error: "forbidden" };
      }
      if (!body.branchId) {
        return { ok: false, error: "branchId required" };
      }
      const branch = await this.prisma
        .forTenant(ctx.tenantId)
        .branch.findFirst({ where: { id: body.branchId, deletedAt: null } });
      if (!branch) {
        return { ok: false, error: "branch not found" };
      }
      const room = rtRooms.branchCatalog(body.branchId);
      await socket.join(room);
      return { ok: true, room };
    }

    return { ok: false, error: "unknown channel" };
  }

  emitToRooms(rooms: string[], event: string, payload: unknown): void {
    if (!this.server) {
      this.logger.warn("Realtime server not initialized — dropping event");
      return;
    }
    this.server.to(rooms).emit(event, payload);
  }
}
