/**
 * DATABASE_DRIVER=mariadb: the connection settings read from DATABASE_URL, and
 * the migration runner's choice of what to apply. For MySQL users on
 * sha256_password, which Prisma's own engine cannot sign in as.
 */

import { describe, expect, it } from "vitest";
import { mysqlSettingsFromUrl } from "../src/lib/mysqlUrl.js";
import { migrationChecksum, pendingMigrations } from "../src/migrate.js";

describe("mysqlSettingsFromUrl", () => {
  it("decodes a percent-encoded password with ( ) and @ in it", () => {
    const settings = mysqlSettingsFromUrl("mysql://sydur:g%29iOmK.bg%28Wwl%403K@f17vwovt93hmtahg8ca0j2j0:3306/framefic-memberframe");
    expect(settings).toEqual({
      host: "f17vwovt93hmtahg8ca0j2j0",
      port: 3306,
      user: "sydur",
      password: "g)iOmK.bg(Wwl@3K",
      database: "framefic-memberframe",
      allowPublicKeyRetrieval: true,
    });
  });

  it("defaults the port, reads a pool size, and an empty password", () => {
    expect(mysqlSettingsFromUrl("mysql://root:@127.0.0.1/memberframe?connection_limit=5")).toMatchObject({
      port: 3306,
      password: "",
      connectionLimit: 5,
    });
    expect(mysqlSettingsFromUrl("mysql://root@db/memberframe", 9).connectionLimit).toBe(9);
  });

  it("refuses what is not a MySQL URL with a database", () => {
    expect(() => mysqlSettingsFromUrl("not a url")).toThrow(/valid URL/);
    expect(() => mysqlSettingsFromUrl("postgres://u:p@h/db")).toThrow(/mysql:\/\//);
    expect(() => mysqlSettingsFromUrl("mysql://u:p@h:3306/")).toThrow(/no database/);
  });
});

describe("the migration runner", () => {
  it("applies what has not finished, in name order", () => {
    const result = pendingMigrations(
      ["20261016000000_payments", "20261012000000_init", "20261012000001_mysql_specifics"],
      [{ name: "20261012000000_init", finished: true, rolledBack: false }]
    );
    expect(result).toEqual({ pending: ["20261012000001_mysql_specifics", "20261016000000_payments"], failed: [] });
  });

  it("stops on a half-applied migration, and retries one marked rolled back", () => {
    expect(pendingMigrations(["a", "b"], [{ name: "a", finished: false, rolledBack: false }]).failed).toEqual(["a"]);
    expect(pendingMigrations(["a", "b"], [{ name: "a", finished: false, rolledBack: true }])).toEqual({ pending: ["a", "b"], failed: [] });
  });

  it("uses Prisma's checksum, SHA-256 of the file as hex", () => {
    // sha256("abc"), the standard test vector.
    expect(migrationChecksum("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
