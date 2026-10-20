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
