import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Local-disk image storage for logos/product/category images — the one
 * store this project has today. No S3/Cloudinary account exists to point
 * at instead, so this is deliberately simple: works with
 * docker-compose.prod.yml's `uploads` named volume (persists across
 * container restarts), but NOT across a volume wipe, and NOT at all on a
 * host with an ephemeral filesystem (Render's free tier — an upload survives
 * until the next redeploy, then is gone). Swap this service for an
 * S3-compatible client later without touching callers — they only see
 * saveImage()/readImage()'s public shape.
 */
const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

function uploadsRoot(): string {
  return resolve(process.env.UPLOADS_DIR ?? "./uploads");
}

/** tenantId is a UUID from the authenticated context, never client input — safe to use as a path segment. */
function tenantDir(tenantId: string): string {
  return join(uploadsRoot(), tenantId);
}

@Injectable()
export class UploadsService {
  async saveImage(
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<{ url: string; filename: string }> {
    const ext = ALLOWED_MIME_TYPES[file.mimetype];
    if (!ext) {
      throw new BadRequestException(
        `Unsupported image type: ${file.mimetype}. Allowed: PNG, JPEG, WEBP.`,
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`Image exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
    }

    // The filename is always server-generated (UUID + extension derived from
    // the verified mimetype) — the client's original filename is never used
    // for the path, so there is no path-traversal or extension-spoofing
    // surface here regardless of what the browser sends.
    const filename = `${randomUUID()}.${ext}`;
    const dir = tenantDir(tenantId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), file.buffer);

    const origin = (process.env.PUBLIC_API_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
    return { url: `${origin}/api/v1/uploads/${tenantId}/${filename}`, filename };
  }

  /**
   * Serves one uploaded file. `filename` must already be validated by the
   * caller (UUID.ext shape) before this is reached — see the controller's
   * regex-constrained route param.
   */
  async readImage(tenantId: string, filename: string): Promise<{ buffer: Buffer; contentType: string }> {
    const filePath = join(tenantDir(tenantId), filename);
    // Defense in depth: even though the route param is regex-constrained,
    // re-verify the resolved path stays inside this tenant's directory.
    if (!filePath.startsWith(tenantDir(tenantId) + "/")) {
      throw new NotFoundException("Image not found");
    }
    try {
      await stat(filePath);
    } catch {
      throw new NotFoundException("Image not found");
    }
    const ext = filename.split(".").pop() ?? "";
    const contentType = Object.entries(ALLOWED_MIME_TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    return { buffer: await readFile(filePath), contentType };
  }
}
