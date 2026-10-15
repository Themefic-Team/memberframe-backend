/**
 * The Prisma client, and the MySQL connection behind it.
 *
 * One instance for the process. Prisma holds a connection pool, so a second
 * client means a second pool, and on shared MySQL hosting the per-user
 * connection cap can be as low as 25. Two pools of eleven plus a `prisma
 * studio` session is how you discover that number.
 *
 * The `globalThis` cache is for `tsx watch`: a file change re-evaluates the
 * module without ending the process, so a plain module-level `new
 * PrismaClient()` would leak a pool on every save until MySQL refused.
 */

import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";

declare global {
  // eslint-disable-next-line no-var
  var __memberframePrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  return new PrismaClient({
    // Queries at debug level only. A query log in production writes every
    // email address this API touches into a log file nobody is guarding.
    log: env.isProduction
      ? [{ emit: "stdout", level: "error" }]
      : [
          { emit: "stdout", level: "error" },
          { emit: "stdout", level: "warn" },
        ],

    datasources: {
      db: { url: databaseUrl() },
    },
  });
}

/**
 * The connection string, with the pool size appended when one is configured.
 *
 * Prisma takes `connection_limit` as a query parameter rather than an option,
 * so it has to be spliced into the URL. Done here rather than in `.env` so the
 * developer sets a number instead of remembering a parameter name.
 */
function databaseUrl(): string {
  const base = env.database.url;
  if (env.database.connectionLimit <= 0) return base;

  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}connection_limit=${env.database.connectionLimit}`;
}

export const prisma: PrismaClient = globalThis.__memberframePrisma ?? createClient();

if (!env.isProduction) globalThis.__memberframePrisma = prisma;

// ============================================================================
// CONNECTION CHECK
// ============================================================================

export interface DatabaseStatus {
  connected: boolean;
  version: string | null;
  database: string | null;
  /** Problems that will bite later, not now. */
  warnings: string[];
  error: string | null;
}

/**
 * Can we reach MySQL, and is it the MySQL this schema needs?
 *
 * Called by `npm run db:check` and by the health endpoint. It answers more than
 * "did it connect", because the two failures that waste the most time are a
 * server too old for the features the schema uses, and a database whose
 * collation will mangle an emoji in a member's name.
 */
export async function checkDatabase(): Promise<DatabaseStatus> {
  const warnings: string[] = [];

  try {
    const rows = await prisma.$queryRaw<
      Array<{ version: string; db: string | null; charset: string; collation: string }>
    >`
      SELECT
        VERSION() AS version,
        DATABASE() AS db,
        @@character_set_database AS charset,
        @@collation_database AS collation
    `;

    const row = rows[0];
    if (!row) {
      return {
        connected: true,
        version: null,
        database: null,
        warnings: ["Connected, but the server returned no version row."],
        error: null,
      };
    }

    // 8.0.13 is the floor: the generated column in the hand-written migration
    // and `utf8mb4_0900_as_ci` both need MySQL 8. MariaDB reports its own
    // version string and does not have the 0900 collations at all.
    const major = Number(row.version.split(".")[0] ?? "0");

    if (row.version.toLowerCase().includes("mariadb")) {
      warnings.push(
        `MariaDB detected (${row.version}). The schema needs MySQL 8: utf8mb4_0900_as_ci does not exist in MariaDB.`
      );
    } else if (major < 8) {
      warnings.push(
        `MySQL ${row.version} is running. Generated columns are supported, but MySQL 8.0+ is recommended for utf8mb4_0900_as_ci accent sensitivity.`
      );
    }

    if (!row.charset.startsWith("utf8mb4")) {
      warnings.push(
        `Database charset is ${row.charset}, not utf8mb4. A name with an emoji or a non-Latin script will be rejected or mangled.`
      );
    }

    return {
      connected: true,
      version: row.version,
      database: row.db,
      warnings,
      error: null,
    };
  } catch (error) {
    return {
      connected: false,
      version: null,
      database: null,
      warnings,
      error: explainConnectionError(error),
    };
  }
}

/**
 * Turn a driver error into the sentence that says what to do.
 *
 * Prisma's own messages are good but generic, and three of these failures have
 * a specific cause on a Windows development machine that the generic message
 * does not mention.
 */
export function explainConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("ECONNREFUSED")) {
    return [
      "MySQL refused the connection.",
      "  Is the server running? On Laragon, start it from the tray.",
      "  Is DATABASE_URL pointing at 127.0.0.1 rather than localhost? On Windows,",
      "  localhost can resolve to IPv6 ::1 while MySQL listens only on IPv4.",
    ].join("\n");
  }

  if (message.includes("ER_ACCESS_DENIED") || message.includes("Access denied")) {
    return [
      "MySQL rejected the credentials.",
      "  If the password is empty, write nothing between the colon and the at sign:",
      "    mysql://root:@127.0.0.1:3306/memberframe",
      "  If it contains @ : / ? # or %, percent-encode it, or the URL splits in",
      "  the wrong place and the error names the wrong host.",
    ].join("\n");
  }

  if (message.includes("ER_BAD_DB_ERROR") || message.includes("Unknown database")) {
    return [
      "The database does not exist. Prisma creates tables, not the schema itself:",
      '  mysql -u root -e "CREATE DATABASE memberframe CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"',
    ].join("\n");
  }

  if (message.includes("ETIMEDOUT") || message.includes("ENOTFOUND")) {
    return [
      "MySQL could not be reached at that host.",
      "  Check the hostname in DATABASE_URL. On remote hosting, check whether your",
      "  IP needs allowlisting first.",
    ].join("\n");
  }

  if (message.includes("@prisma/client did not initialize")) {
    return "Prisma Client has not been generated yet. Run: npm run db:generate";
  }

  return message;
}

/** Close the pool. Called on shutdown so MySQL is not left holding connections. */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
