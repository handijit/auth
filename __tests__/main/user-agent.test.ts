import { describe, expect, test } from "vitest";

import buildUserAgent from "../../lib/main/user-agent";

const PARTS = {
  product: "notlar",
  version: "1.4.0",
  platform: "darwin",
  systemVersion: "15.1.0",
  arch: "arm64",
};

describe("buildUserAgent", () => {
  test("should name the program, its version and the machine", () => {
    expect(buildUserAgent(PARTS)).toBe("notlar/1.4.0 (macOS 15.1.0; arm64)");
  });

  test.each([
    ["win32", "Windows"],
    ["linux", "Linux"],
    ["freebsd", "freebsd"],
  ])("should call %s %s", (platform, name) => {
    expect(
      buildUserAgent({ ...PARTS, platform, systemVersion: "10.0.26100" })
    ).toBe(`notlar/1.4.0 (${name} 10.0.26100; arm64)`);
  });

  test("should stay a header value whatever the parts contain", () => {
    const value = buildUserAgent({
      product: "not lar",
      version: "1.4.0-beta 2\n",
      platform: "plan 9",
      systemVersion: "Sürüm 15",
      arch: "x64\r\nX-Injected: 1",
    });
    expect(value).toBe("notlar/1.4.0-beta2 (plan9 Srm15; x64X-Injected:1)");
    expect(value).toMatch(/^[\x20-\x7E]+$/);
  });
});
