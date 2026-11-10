import { describe, expect, test } from "vitest";

import reasonOf from "../../lib/main/reason-of.helper";

describe("reasonOf", () => {
  test("should use the message of an Error", () => {
    expect(reasonOf(new TypeError("fetch failed"))).toBe("fetch failed");
  });

  test.each([
    ["EPERM", "EPERM"],
    [404, "404"],
    [undefined, "undefined"],
    [null, "null"],
  ])("should write %s as text", (value, expected) => {
    expect(reasonOf(value)).toBe(expected);
  });
});
