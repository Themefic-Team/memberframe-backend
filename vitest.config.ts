import { defineConfig } from "vitest/config";

/**
 * Node environment, pure logic only, same as the frontend package.
 *
 * No test here touches MySQL. Everything that needs a database is an
 * integration test, which needs a disposable schema and a migration run, and
 * that is a separate decision with a separate cost. What these cover is the
 * logic that can be wrong without any database being involved: the hashing,
 * the token handling, the cookie attributes, the rate-limit arithmetic, and
 * above all the parity between the three copies of the shared rules.
 *
 * `backend/test` is deliberately outside the frontend's vitest `include`, so
 * `npm test` at the repo root does not try to run these without the backend's
 * own dependencies installed.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
