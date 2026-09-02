import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

import { normalizeEmail } from "../../modules/identity/email-normalization";

/**
 * One-time data repair for legacy emails created BEFORE normalizeEmail()
 * existed. Back then `user+anything@x` was stored as a separate account, so
 * the same Gmail inbox accumulated several accounts — and after normalization
 * shipped, login (which folds +tags to the base address) can only see the
 * BASE account. If that base is unverified (a stuck attempt from the broken
 * era) while a +tag variant is the one the merchant actually verified, the
 * merchant is locked out of their verified account by their own unverified
 * shadow. Runs only when RUN_DB_REPAIR_EMAILS=true (same gated-once pattern
 * as bootstrapAppRoleIfRequested / runDbMigrationsIfRequested).
 *
 * Repair rule per canonical group (all users sharing a folded base address):
 *   survivor = the VERIFIED account if any, else the newest;
 *   - survivor gets the canonical base address (frees the +tag spelling);
 *   - every other account in the group is retired in place: deactivated,
 *     email moved to `retired+<id>@invalid.local` (keeps audit trail, frees
 *     the unique index), phone cleared (frees the anti-abuse unique phone).
 *
 * Idempotent: a second run finds nothing to change.
 */
export async function repairLegacyEmailsIfRequested(): Promise<void> {
  if (process.env.RUN_DB_REPAIR_EMAILS !== "true") {
    return;
  }
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error("RUN_DB_REPAIR_EMAILS=true but ADMIN_DATABASE_URL is not set - skipping.");
    return;
  }

  const logger = new Logger("EmailRepair");
  const db = new PrismaClient({ datasourceUrl: adminUrl });

  try {
    const users = await db.user.findMany({
      select: { id: true, email: true, emailVerifiedAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Group by folded address, EXCLUDING already-retired placeholder emails.
    const groups = new Map<string, typeof users>();
    for (const u of users) {
      if (u.email.endsWith("@invalid.local")) continue; // previously retired
      const canonical = normalizeEmail(u.email);
      const list = groups.get(canonical) ?? [];
      list.push(u);
      groups.set(canonical, list);
    }

    let repaired = 0;
    for (const [canonical, group] of groups) {
      const offenders = group.filter((u) => u.email !== canonical);
      if (offenders.length === 0 && group.length === 0) continue;
      if (group.length === 1 && group[0].email === canonical) continue; // healthy

      // Survivor: verified wins (that's the account the human actually uses);
      // otherwise the newest (most recent state). Never pick a retired one.
      const verified = group.find((u) => u.emailVerifiedAt);
      const survivor = verified ?? group[group.length - 1];
      const losers = group.filter((u) => u.id !== survivor.id);

      logger.log(`group ${canonical}: survivor=${survivor.email} losers=${losers.length}`);

      for (const loser of losers) {
        await db.user.update({
          where: { id: loser.id },
          data: {
            isActive: false,
            email: `retired+${loser.id}@invalid.local`,
            phone: null,
          },
        });
        repaired++;
      }

      if (survivor.email !== canonical) {
        await db.user.update({
          where: { id: survivor.id },
          data: { email: canonical },
        });
        repaired++;
      }
    }

    logger.log(`done — ${repaired} account update(s) across ${groups.size} group(s).`);
  } finally {
    await db.$disconnect();
  }
}