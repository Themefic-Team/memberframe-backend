/**
 * `npm run db:seed`
 *
 * One creator, one site, and the four-tier ladder, which is the minimum needed
 * to point a Framer component at this API and try the cookie spike in backend
 * PRD section 2.3.
 *
 * Idempotent: running it twice updates rather than duplicating, so it is safe
 * to re-run after a migration.
 *
 * It creates NO member. Members arrive by registering, and a seeded member
 * with a known password is the kind of thing that survives into production.
 */

import { disconnectDatabase, prisma } from "../src/config/db.js";
import { hashPassword } from "../src/lib/password.js";
import { generateGrantSalt, generateSiteKey } from "../src/lib/tokens.js";
import { defaultSettings, toJsonDocument } from "../src/lib/siteSettings.js";

const CREATOR_EMAIL = "creator@memberframe.test";
const SITE_NAME = "Demo Site";

/**
 * Origins the demo site accepts.
 *
 * Localhost entries are for calling the API from a local page. **The Framer
 * origin has to be added by hand**, because only you know your published site's
 * hostname, and a wildcard is not an option: see `middleware/site.ts` for why
 * `Allow-Origin: *` cannot coexist with credentialed requests.
 */
const ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "https://127.0.0.1:5173",
  "http://localhost:5173",
  "https://localhost:5173",
];

const TIERS = [
  { key: "free_member", name: "Free", rank: 0, monthlyPriceMinor: null },
  { key: "tier_1", name: "Silver", rank: 1, monthlyPriceMinor: 900 },
  { key: "tier_2", name: "Gold", rank: 2, monthlyPriceMinor: 1900 },
  { key: "vip", name: "VIP", rank: 3, monthlyPriceMinor: 4900 },
] as const;

async function main(): Promise<void> {
  const creator = await prisma.user.upsert({
    where: { email: CREATOR_EMAIL },
    update: {},
    create: {
      email: CREATOR_EMAIL,
      name: "Demo Creator",
      // A random password nobody knows. The creator dashboard does not exist
      // (the plan dropped it), so nothing signs in as this row yet, and a
      // seeded known password would be a backdoor waiting to be deployed.
      passwordHash: await hashPassword(generateGrantSalt()),
    },
  });

  const existing = await prisma.site.findFirst({
    where: { userId: creator.id, siteName: SITE_NAME },
    select: { id: true, siteKey: true },
  });

  const site = existing
    ? await prisma.site.update({
        where: { id: existing.id },
        // The key is preserved on re-seed. Rotating it would silently break
        // every component already deployed with it baked in.
        data: { allowedOrigins: ALLOWED_ORIGINS },
        select: { id: true, siteKey: true, siteName: true },
      })
    : await prisma.site.create({
        data: {
          userId: creator.id,
          siteName: SITE_NAME,
          siteKey: generateSiteKey(),
          grantSalt: generateGrantSalt(),
          allowedOrigins: ALLOWED_ORIGINS,
        },
        select: { id: true, siteKey: true, siteName: true },
      });

  for (const tier of TIERS) {
    await prisma.tier.upsert({
      where: { siteId_key: { siteId: site.id, key: tier.key } },
      update: { name: tier.name, rank: tier.rank, monthlyPriceMinor: tier.monthlyPriceMinor },
      create: {
        siteId: site.id,
        key: tier.key,
        name: tier.name,
        rank: tier.rank,
        monthlyPriceMinor: tier.monthlyPriceMinor,
        currency: "USD",
      },
    });
  }

  // Every site needs its settings document. A site without one still reads
  // (loadSiteSettings falls back to defaults), but a creator saving one
  // setting would then write a document built from defaults rather than from
  // whatever the seed intended, which is a confusing first experience.
  await prisma.siteSettings.upsert({
    where: { siteId: site.id },
    create: {
      siteId: site.id,
      settings: toJsonDocument({
        ...defaultSettings(),
        branding: { displayName: site.siteName, supportEmail: CREATOR_EMAIL },
      }),
    },
    update: {},
  });

  process.stdout.write(
    [
      "",
      "  Seeded.",
      "",
      `  creator   ${CREATOR_EMAIL}`,
      `  site      ${site.siteName}`,
      `  site key  ${site.siteKey}`,
      `  tiers     ${TIERS.map((tier) => `${tier.key}:${tier.rank}`).join("  ")}`,
      "",
      "  Send the site key on every member request:",
      "",
      `    X-MemberFrame-Site: ${site.siteKey}`,
      "",
      "  Try it:",
      "",
      `    curl -i http://127.0.0.1:4000/api/member/session \\`,
      `      -H "X-MemberFrame-Site: ${site.siteKey}"`,
      "",
      "  Expect 401 with the tier ladder, which is the correct answer for a",
      "  visitor who is not signed in.",
      "",
      "  This site was seeded, not connected. The ordinary route is the",
      "  plugin's Connect tab, which creates the creator, the site, the tier",
      "  ladder, and the settings document in one step, and which is the only",
      "  way to get a creator token for the Manage and Settings tabs.",
      "",
      "  Before a published Framer site can use this, add its origin to",
      "  allowed_origins on the sites row, or let the Connect tab do it.",
      "  Nothing here can guess it, and a wildcard is not accepted.",
      "",
    ].join("\n")
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
