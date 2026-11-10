import { describe, expect, test } from "vitest";

import { buildSignInUrl, readPanelBaseUrl } from "../../lib/main/panel-url";

describe("readPanelBaseUrl", () => {
  test("should default to the production site on the www host", () => {
    expect(readPanelBaseUrl(undefined)).toBe("https://www.handijit.com");
  });

  test.each([
    ["https://www.handijit.com", "https://www.handijit.com"],
    ["https://www.handijit.com/", "https://www.handijit.com"],
    ["https://staging.handijit.com///", "https://staging.handijit.com"],
    ["https://example.com/site/", "https://example.com/site"],
    ["http://127.0.0.1:3100", "http://127.0.0.1:3100"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("should accept %s", (value, expected) => {
    expect(readPanelBaseUrl(value)).toBe(expected);
  });

  test.each([
    "",
    "www.handijit.com",
    "/panel",
    "http://www.handijit.com",
    "http://192.168.1.10:3000",
    "http://127.0.0.1.example.com",
    "ftp://www.handijit.com",
    "file:///tmp/site",
    "javascript:alert(1)",
    "https://user:secret@www.handijit.com",
    "https://user@www.handijit.com",
    "https://www.handijit.com/?next=1",
    "https://www.handijit.com/#top",
  ])("should refuse %s", (value) => {
    expect(() => readPanelBaseUrl(value)).toThrow(TypeError);
    expect(() => readPanelBaseUrl(value)).toThrow(
      /^createAuth: options\.panelBaseUrl must be an https URL/
    );
  });
});

describe("buildSignInUrl", () => {
  test("should write the consent page's address with the backend's parameter names", () => {
    const url = buildSignInUrl({
      panelBaseUrl: "https://www.handijit.com",
      product: "notlar",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      redirectUri: "http://127.0.0.1:51234/callback",
      state: "a_b-c",
    });
    expect(url).toBe(
      "https://www.handijit.com/panel/masaustu-giris?product=notlar&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&state=a_b-c"
    );
  });

  test("should encode whatever a value contains", () => {
    const url = new URL(
      buildSignInUrl({
        panelBaseUrl: "http://127.0.0.1:3100",
        product: "notlar",
        codeChallenge: "c",
        redirectUri: "http://127.0.0.1:2000/callback",
        state: "a&b=c d#e",
      })
    );
    expect(url.searchParams.get("state")).toBe("a&b=c d#e");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:2000/callback"
    );
    expect([...url.searchParams.keys()]).toEqual([
      "product",
      "code_challenge",
      "redirect_uri",
      "state",
    ]);
  });
});
