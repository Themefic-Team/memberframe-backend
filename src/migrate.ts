/**
 * `node dist/migrate.js`: apply pending database migrations, then exit.
 *
 * Run before the server on every deploy (Dockerfile CMD, or a host's start
 * command: `node dist/migrate.js && node dist/server.js`).
 *
 * - DATABASE_DRIVER=prisma (default): runs `prisma migrate deploy`.
 * - DATABASE_DRIVER=mariadb: applies `prisma/migrations/<name>/migration.sql`
 *   itself through the MariaDB JavaScript driver, because `prisma migrate`
 *   signs in with Prisma's engine and fails for a MySQL user on
 *   sha256_password ("Unknown authentication plugin"). It records each one in
 *   Prisma's own `_prisma_migrations` table, with Prisma's checksum, so either
 *   tool can take over later and sees the same history.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as mariadb from "mariadb";
import { env } from "./config/env.js";
import { mysqlSettingsFromUrl } from "./lib/mysqlUrl.js";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");
const LOCK_NAME = "memberframe_migrate";

function log(message: string): void {
  process.stdout.write(`[migrate] ${message}\n`);
}

/** Migration folders in the order Prisma applies them: by name, which starts with a timestamp. */
export function pendingMigrations(
  folders: ReadonlyArray<string>,
  applied: ReadonlyArray<{ name: string; finished: boolean; rolledBack: boolean }>
): { pending: string[]; failed: string[] } {
  const done = new Set(applied.filter((row) => row.finished && !row.rolledBack).map((row) => row.name));
  const failed = applied.filter((row) => !row.finished && !row.rolledBack).map((row) => row.name);
  return { pending: [...folders].sort().filter((name) => !done.has(name)), failed };
}

/** Prisma's checksum for a migration: SHA-256 of the file, as hex. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function migrationFolders(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) throw new Error(`No migrations folder at ${MIGRATIONS_DIR}`);
  return readdirSync(MIGRATIONS_DIR).filter((name) => {
    const full = path.join(MIGRATIONS_DIR, name);
    return statSync(full).isDirectory() && existsSync(path.join(full, "migration.sql"));
  });
}

const CREATE_HISTORY = `CREATE TABLE IF NOT EXISTS \`_prisma_migrations\` (
  \`id\` VARCHAR(36) NOT NULL,
  \`checksum\` VARCHAR(64) NOT NULL,
  \`finished_at\` DATETIME(3) NULL,
  \`migration_name\` VARCHAR(255) NOT NULL,
  \`logs\` TEXT NULL,
  \`rolled_back_at\` DATETIME(3) NULL,
  \`started_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`applied_steps_count\` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;

async function migrateWithMariaDb(): Promise<void> {
  const settings = mysqlSettingsFromUrl(env.database.url);
  const connection = await mariadb.createConnection({ ...settings, multipleStatements: true, connectTimeout: 15_000 });
  log(`connected to ${settings.host}:${settings.port}/${settings.database} as ${settings.user}`);

  try {
    // One deploy at a time: a second container waits rather than racing.
    const [lock] = (await connection.query("SELECT GET_LOCK(?, 120) AS got", [LOCK_NAME])) as Array<{ got: number | bigint }>;
    if (Number(lock?.got) !== 1) throw new Error("Another deploy is migrating this database. Try again in a minute.");

    await connection.query(CREATE_HISTORY);
    const rows = (await connection.query(
      "SELECT migration_name, checksum, finished_at, rolled_back_at FROM `_prisma_migrations`"
    )) as Array<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>;

    const { pending, failed } = pendingMigrations(
      migrationFolders(),
      rows.map((row) => ({ name: row.migration_name, finished: row.finished_at !== null, rolledBack: row.rolled_back_at !== null }))
    );
    if (failed.length > 0) {
      throw new Error(
        `Migration ${failed.join(", ")} failed on an earlier deploy and is half applied. Fix the database by hand, then mark it rolled back: ` +
          `UPDATE _prisma_migrations SET rolled_back_at = NOW(3) WHERE migration_name = '${failed[0]}' AND finished_at IS NULL;`
      );
    }

    for (const row of rows) {
      const file = path.join(MIGRATIONS_DIR, row.migration_name, "migration.sql");
      if (row.finished_at && existsSync(file) && migrationChecksum(readFileSync(file, "utf8")) !== row.checksum) {
        log(`warning: ${row.migration_name} was edited after it was applied. It is not run again.`);
      }
    }

    if (pending.length === 0) {
      log("database is up to date");
      return;
    }

    for (const name of pending) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
      const id = randomUUID();
      await connection.query(
        "INSERT INTO `_prisma_migrations` (id, checksum, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, NOW(3), 0)",
        [id, migrationChecksum(sql), name]
      );
      try {
        // MySQL commits each DDL statement on its own, so there is no
        // transaction to roll back: a failure leaves the row unfinished,
        // which the next run reports instead of repeating half a migration.
        await connection.query(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await connection.query("UPDATE `_prisma_migrations` SET logs = ? WHERE id = ?", [message, id]);
        throw new Error(`Migration ${name} failed: ${message}`);
      }
      await connection.query("UPDATE `_prisma_migrations` SET finished_at = NOW(3), applied_steps_count = 1 WHERE id = ?", [id]);
      log(`applied ${name}`);
    }
    log(`${pending.length} migration(s) applied`);
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => undefined);
    await connection.end().catch(() => undefined);
  }
}

function migrateWithPrisma(): void {
  const bin = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
  const result = spawnSync(bin, ["migrate", "deploy"], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error("prisma migrate deploy failed (see above).");
}

async function main(): Promise<void> {
  if (env.database.driver === "mariadb") await migrateWithMariaDb();
  else migrateWithPrisma();
}

// Only when run as a program, so the pure helpers above can be tested.
const invokedDirectly = process.argv[1] !== undefined && /migrate\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`\n[migrate] ${error instanceof Error ? error.message : String(error)}\n\n`);
      process.exit(1);
    }
  );
}
