/**
 * The entry point. The only file that binds a port.
 *
 * Checks the database before accepting traffic, because a server that starts
 * happily and fails every request is harder to diagnose than one that says
 * what is wrong and stops.
 */

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { checkDatabase, disconnectDatabase } from "./config/db.js";
import { sweepExpired } from "./services/payments/apply.js";
import { migratePlaintextIntegrationSecrets } from "./services/integrationSecrets.js";

async function main(): Promise<void> {
  const status = await checkDatabase();

  if (!status.connected) {
    process.stderr.write(
      [
        "",
        "MemberFrame API cannot start: MySQL is unreachable.",
        "",
        status.error ?? "No further detail.",
        "",
        "Check DATABASE_URL in .env, then run: npm run db:check",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  // Warnings do not stop the boot. A charset that will mangle an emoji in a
  // member's name is worth saying loudly and is not a reason to refuse
  // service.
  for (const warning of status.warnings) {
    process.stderr.write(`[warn] ${warning}\n`);
  }

  // Sign in provider secrets saved before encryption existed move into the
  // encrypted store once, here. A no-op on every later start.
  try {
    const moved = await migratePlaintextIntegrationSecrets();
    if (moved > 0) process.stdout.write(`[secrets] encrypted provider secrets for ${moved} site(s)
`);
  } catch (error) {
    process.stderr.write(`[secrets] could not move provider secrets: ${error instanceof Error ? error.message : String(error)}
`);
  }

  const app = createApp();

  const server = app.listen(env.port, () => {
    process.stdout.write(
      [
        "",
        `  MemberFrame API`,
        `  listening   http://127.0.0.1:${env.port}`,
        `  public url  ${env.apiBaseUrl}`,
        `  environment ${env.nodeEnv}`,
        `  mysql       ${status.version ?? "unknown"} / ${status.database ?? "unknown"}`,
        `  mail driver ${env.mail.driver}${env.mail.driver === "log" ? " (writes to storage/mail, sends nothing)" : ""}`,
        `  cookie      ${env.session.crossSite ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"}`,
        "",
      ].join("\n")
    );

    if (!env.session.crossSite) {
      process.stdout.write(
        [
          "  Note: SESSION_COOKIE_CROSS_SITE is off, so the session cookie is",
          "  same-site only. A canvas component on a published Framer site will",
          "  not be able to hold a session until this is on and the API is on",
          "  https. See backend PRD section 4.1.",
          "",
        ].join("\n")
      );
    }
  });

  // FP-16 section 10. Ends canceled plans past their period and failed
  // payments past their grace window, a safety net under the gateways' own
  // events. Unref'd so it never holds the process open on shutdown.
  const sweep = setInterval(() => {
    void sweepExpired().then(
      (ended) => {
        if (ended > 0) process.stdout.write(`[payments] sweep ended ${ended} subscription(s)
`);
      },
      (error: unknown) => {
        process.stderr.write(`[payments] sweep failed: ${error instanceof Error ? error.message : String(error)}
`);
      }
    );
  }, Math.max(30, env.payments.sweepSeconds) * 1000);
  sweep.unref();

  // Shut down in order: stop accepting connections, finish what is in flight,
  // then release the MySQL pool. Exiting without the last leaves connections
  // held until the server times them out, and on cheap hosting the per-user
  // cap is low enough to notice after a few restarts.
  const shutdown = (signal: string): void => {
    process.stdout.write(`\n${signal} received, shutting down.\n`);

    server.close(() => {
      void disconnectDatabase().then(
        () => process.exit(0),
        () => process.exit(1)
      );
    });

    // A connection that never closes must not hold the process open forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
