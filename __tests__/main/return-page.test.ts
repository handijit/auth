import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  DONE_PAGE,
  INVALID_PAGE,
  returnPageCsp,
} from "../../lib/main/return-page";

const styleOf = (html: string): string =>
  (/<style>([\s\S]*?)<\/style>/.exec(html) as RegExpExecArray)[1] as string;

describe("the page the browser lands on", () => {
  test("should tell the customer in Turkish to go back to the program", () => {
    expect(DONE_PAGE).toContain('<html lang="tr">');
    expect(DONE_PAGE).toContain("<title>Giriş tamamlandı · Han Dijit</title>");
    expect(DONE_PAGE).toContain("<h1>Programa dönebilirsiniz</h1>");
    expect(DONE_PAGE).toContain(
      "<p>Giriş programda tamamlanıyor. Bu sekmeyi kapatabilirsiniz.</p>"
    );
  });

  test("should have a page of its own for a link that is not a sign-in", () => {
    expect(INVALID_PAGE).toContain("<h1>Bu bağlantı geçersiz</h1>");
    expect(INVALID_PAGE).toContain('class="mark bad"');
    expect(DONE_PAGE).not.toContain('class="mark bad"');
  });

  test.each([
    ["done", DONE_PAGE],
    ["invalid", INVALID_PAGE],
  ])(
    "should stand alone: the %s page loads nothing and runs nothing",
    (_name, html) => {
      expect(html).not.toMatch(/<script|<link|<img|<iframe|<form|<a /i);
      expect(html).not.toMatch(/\b(?:src|href|action)=/i);
      expect(html).not.toMatch(/url\(|@import|https?:/i);
      expect(html).not.toMatch(/ on[a-z]+=/i);
      expect(html).not.toMatch(/ style=/i);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<meta charset="utf-8">');
    }
  );

  test("should follow the system's light and dark setting", () => {
    const style = styleOf(DONE_PAGE);
    expect(style).toContain("color-scheme:light dark");
    expect(style).toContain("@media (prefers-color-scheme:dark)");
    expect(styleOf(INVALID_PAGE)).toBe(style);
  });
});

describe("returnPageCsp", () => {
  test("should allow nothing but the one inline style sheet, by its hash", () => {
    const hash = createHash("sha256")
      .update(styleOf(DONE_PAGE))
      .digest("base64");
    expect(returnPageCsp()).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
  });

  test("should have exactly one style element to allow", () => {
    expect(DONE_PAGE.match(/<style>/g)).toHaveLength(1);
    expect(INVALID_PAGE.match(/<style>/g)).toHaveLength(1);
  });
});
