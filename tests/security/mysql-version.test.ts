import { describe, expect, it } from "vitest";
import { serverStatement, versionProblem } from "../../packages/core/src/mysql.ts";

describe("the MySQL statement time limit is an optimizer hint, so a server that ignores it is refused", () => {
  it("accepts MySQL 5.7.8 and later", () => {
    for (const v of ["5.7.8", "5.7.44-log", "8.0.36", "8.4.2", "9.1.0"]) expect(versionProblem(v), v).toBeUndefined();
  });

  it("refuses MariaDB, older MySQL and an unknown version", () => {
    for (const v of ["10.11.6-MariaDB", "5.5.5-10.6.12-MariaDB-log", "5.7.7", "5.6.51", "5.7.0", "", undefined, "garbage"]) {
      expect(versionProblem(v), String(v)).toBeTypeOf("string");
    }
  });

  it("bounds the limit by what the server variable can hold", () => {
    expect(() => serverStatement("select 1", 4_294_967_296)).toThrow(/at most 4294967295/);
    expect(serverStatement("select 1", 4_294_967_295)).toContain("MAX_EXECUTION_TIME(4294967295)");
  });
});
