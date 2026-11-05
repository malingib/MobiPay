import type pg from "pg";
import { getPool } from "./db.js";
import { isPlatformAdminCapability } from "./platformAdminSession.js";
import type { PlatformAdminCapability } from "./platformAdminSession.js";

/**
 * Platform-admin database path. The capability is created only by the verified
 * platform-admin session middleware. This is an application authorization
 * boundary, not a substitute for a distinct least-privilege PostgreSQL role.
 */
export async function withPlatformAdminTransaction<T>(
  capability: PlatformAdminCapability,
  operation: (client: pg.PoolClient, actor: string) => Promise<T>,
  dbPool: Pick<pg.Pool, "connect"> = getPool(),
): Promise<T> {
  if (!isPlatformAdminCapability(capability)) {
    throw new Error("A verified platform-admin capability is required");
  }
  const client = await dbPool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;
    const result = await operation(client, capability.username);
    await client.query("COMMIT");
    active = false;
    return result;
  } catch (error) {
    if (active) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
