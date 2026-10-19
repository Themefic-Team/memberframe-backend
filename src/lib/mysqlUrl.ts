/**
 * `DATABASE_URL` as settings for the MariaDB JavaScript driver, which the app
 * uses when `DATABASE_DRIVER=mariadb` (see `config/db.ts`) and which the
 * migration runner always uses for that mode (`src/migrate.ts`).
 *
 * The URL is the same one Prisma reads: `mysql://user:password@host:port/db`,
 * with the user and password percent-encoded. `allowPublicKeyRetrieval` lets
 * the driver sign in with `sha256_password` or `caching_sha2_password` over a
 * private network without TLS, by asking the server for its RSA public key.
 */

export interface MysqlConnectionSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  allowPublicKeyRetrieval: boolean;
  connectionLimit?: number;
  ssl?: boolean;
}

export function mysqlSettingsFromUrl(url: string, connectionLimit = 0): MysqlConnectionSettings {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL. Expected mysql://user:password@host:port/database");
  }
  if (parsed.protocol !== "mysql:" && parsed.protocol !== "mariadb:") {
    throw new Error(`DATABASE_URL must start with mysql://, got ${parsed.protocol}//`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL names no database after the host.");

  const sslMode = (parsed.searchParams.get("sslaccept") ?? parsed.searchParams.get("ssl") ?? "").toLowerCase();
  const limitFromUrl = Number(parsed.searchParams.get("connection_limit") ?? "");

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    allowPublicKeyRetrieval: true,
    ...(connectionLimit > 0 ? { connectionLimit } : Number.isInteger(limitFromUrl) && limitFromUrl > 0 ? { connectionLimit: limitFromUrl } : {}),
    ...(sslMode === "true" || sslMode === "strict" || sslMode === "accept_invalid_certs" ? { ssl: true } : {}),
  };
}
