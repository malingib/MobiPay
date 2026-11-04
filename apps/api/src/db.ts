import pg from "pg";

const { Pool } = pg;
let pool: pg.Pool | undefined;

export function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: true },
  });
  return pool;
}

/**
 * Runs merchant work on one checked-out connection with a transaction-local
 * identity for current_payment_user_id(). The setting is parameterized and
 * uses set_config(..., true), so PostgreSQL clears it at transaction end before
 * the pooled connection can be reused.
 *
 * This helper is only for authenticated merchant-user operations. Provider
 * callbacks, background workers, tenant bootstrap and platform-admin work must
 * use separately designed capabilities; never pass a caller-supplied user ID
 * or tenant ID into this helper as a substitute for authenticating that actor.
 *
 * Callers must perform every query for the operation through the supplied
 * client. Do not call pool.query() from inside the callback.
 */
export async function withUserTransaction<T>(
  userId: string,
  operation: (client: pg.PoolClient) => Promise<T>,
  dbPool: Pick<pg.Pool, "connect"> = getPool(),
): Promise<T> {
  if (typeof userId !== "string" || userId.trim().length === 0 || userId.length > 256) {
    throw new Error("A verified user identity is required for a merchant database transaction");
  }

  const client = await dbPool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
