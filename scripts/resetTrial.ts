/**
 * `npm run trial:reset -- <email> [--expire]`, or `-- --all`
 *
 * For testing the 7-day trial in development (19-pro-lock-and-trial.md).
 *
 *   <email>           Forget this account's trial. Next time the plugin is opened
 *                     in a project, a fresh one starts (TRIAL_DURATION_MINUTES long
 *                     when set).
 *   <email> --expire  End this account's trial now, to see what happens when it
 *                     ends: the panel locks, components blur, members get 402,
 *                     and the next license job sends the "trial ended" emails.
 *   --all             Forget every trial in this database.
 *
 * A trial row is one per account, email, Framer user, and project, so after a
 * reset the same account, Framer user, and project can all trial again.
 * Refuses to run with NODE_ENV=production.
 */

import { disconnectDatabase, prisma } from "../src/config/db.js";
import { env } from "../src/config/env.js";

async function main(): Promise<void> {
  if (env.isProduction) {
    process.stderr.write("\n  trial:reset is for development. NODE_ENV is production.\n\n");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const expire = args.includes("--expire");
  const all = args.includes("--all");
  const email = args.find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();

  if (all) {
    const { count } = await prisma.pluginTrial.deleteMany({});
    process.stdout.write(`\n  Forgot ${count} trial(s). Open the plugin in a project to start a new one.\n\n`);
    return;
  }

  if (!email) {
    process.stderr.write("\n  Usage: npm run trial:reset -- you@example.com [--expire]   or   -- --all\n\n");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const where = { OR: [{ email }, ...(user ? [{ userId: user.id }] : [])] };
  const trials = await prisma.pluginTrial.findMany({ where, select: { id: true, projectName: true, endsAt: true, status: true } });
  if (trials.length === 0) {
    process.stdout.write(`\n  ${email} has no trial. Opening the plugin in a project starts one.\n\n`);
    return;
  }

  if (expire) {
    const now = new Date(Date.now() - 1000);
    await prisma.pluginTrial.updateMany({ where, data: { endsAt: now } });
    process.stdout.write(
      `\n  Ended the trial on ${trials.map((t) => t.projectName || "a project").join(", ")}.\n` +
        `  The panel and components lock within a minute. The "trial ended" emails go\n` +
        `  out on the next license job (LICENSE_JOB_SECONDS, ${env.billing.jobSeconds}s).\n\n`
    );
    return;
  }

  await prisma.pluginTrial.deleteMany({ where });
  const length = env.billing.trialMinutes > 0 ? `${env.billing.trialMinutes} minutes` : `${env.billing.trialDays} days`;
  process.stdout.write(`\n  Forgot ${email}'s trial. Open the plugin in a project to start a new one (${length}).\n\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exitCode = 1;
  })
  .finally(() => void disconnectDatabase());
