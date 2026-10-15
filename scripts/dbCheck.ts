/**
 * `npm run db:check`
 *
 * Answers the question that wastes the most time at the start of a project:
 * can this process reach MySQL, and is it the MySQL the schema needs?
 *
 * Reports more than connected or not, because the failures that cost hours are
 * the ones that look like success: a server too old for the generated column
 * in the hand-written migration, a MariaDB install that has no `0900`
 * collations at all, or a database created with the wrong charset so that a
 * member called with an emoji in their name is rejected at insert time.
 */

import { checkDatabase, disconnectDatabase, prisma } from "../src/config/db.js";
import { env } from "../src/config/env.js";

/** Hide the password before printing a connection string. */
function redact(url: string): string {
  return url.replace(/\/\/([^:]*):([^@]*)@/, (_match, user: string) =>
    `//${user}:${"*".repeat(8)}@`
  );
}

async function main(): Promise<void> {
  process.stdout.write(`\n  MemberFrame database check\n`);
  process.stdout.write(`  url  ${redact(env.database.url)}\n\n`);

  const status = await checkDatabase();

  if (!status.connected) {
    process.stdout.write(`  FAILED to connect.\n\n`);
    process.stdout.write(`${(status.error ?? "No detail.").replace(/^/gm, "  ")}\n\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`  connected  yes\n`);
  process.stdout.write(`  server     ${status.version ?? "unknown"}\n`);
  process.stdout.write(`  database   ${status.database ?? "unknown"}\n\n`);

  for (const warning of status.warnings) {
    process.stdout.write(`  WARNING  ${warning}\n`);
  }
  if (status.warnings.length > 0) process.stdout.write("\n");

  // Are the tables there? A connection with no schema means migrations have
  // not run, which is a different problem from a bad URL and deserves a
  // different instruction.
  try {
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT TABLE_NAME AS name
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME
    `;

    const names = tables.map((row) => row.name);

    if (names.length === 0) {
      process.stdout.write(`  tables     none. Run: npm run db:migrate\n\n`);
      return;
    }

    process.stdout.write(`  tables     ${names.length}\n`);
    process.stdout.write(`             ${names.join(", ")}\n\n`);

    // The two things the hand-written migration adds. Prisma cannot express
    // either, so their absence means that migration has not been applied and
    // two live members could share an email address.
    const generated = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'members'
        AND COLUMN_NAME = 'active_email'
    `;

    const hasGenerated = Number(generated[0]?.count ?? 0) > 0;

    const collation = await prisma.$queryRaw<Array<{ collation: string | null }>>`
      SELECT COLLATION_NAME AS collation
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'members'
        AND COLUMN_NAME = 'email'
    `;

    const emailCollation = collation[0]?.collation ?? "unknown";

    process.stdout.write(`  MySQL specifics, from the hand-written migration:\n`);
    process.stdout.write(
      `    active_email column   ${hasGenerated ? "present" : "MISSING. Soft-deleted members still occupy their address"}\n`
    );
    const isExactCollation = emailCollation === "utf8mb4_0900_as_ci";
    process.stdout.write(
      `    members.email         ${emailCollation}${
        isExactCollation
          ? ""
          : "  (Note: utf8mb4_0900_as_ci requires MySQL 8.0+. On MySQL 5.7, standard utf8mb4 is used)"
      }\n\n`
    );

    // The second hand-written migration. Without the collation, a creator
    // connect code minted for one address verifies against an accented
    // spelling of it; without the CHECK, a scalar can reach the settings
    // column. Neither shows up as an error anywhere until it matters.
    const creatorCollation = await prisma.$queryRaw<Array<{ collation: string | null }>>`
      SELECT COLLATION_NAME AS collation
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'creator_otps'
        AND COLUMN_NAME = 'email'
    `;

    const settingsCheck = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'site_settings'
        AND CONSTRAINT_NAME = 'chk_site_settings_is_object'
    `;

    const hasSettingsCheck = Number(settingsCheck[0]?.count ?? 0) > 0;
    const creatorEmailCollation = creatorCollation[0]?.collation ?? "not created yet";

    process.stdout.write(
      `    creator_otps.email    ${creatorEmailCollation}\n`
    );
    process.stdout.write(
      `    settings is an object ${hasSettingsCheck ? "enforced" : "NOT enforced. Run the creator_identity migration"}\n\n`
    );

    if (!hasGenerated) {
      process.stdout.write(`  Run: npm run db:migrate\n\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `  Could not inspect the schema: ${error instanceof Error ? error.message : String(error)}\n\n`
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
