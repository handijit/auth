import { describe, expect, test } from "vitest";

import AUTH_ERROR_CODES from "../../lib/shared/auth-error-codes.constants";
import authErrorMessage from "../../lib/shared/auth-error-message";
import createAuthError from "../../lib/shared/create-auth-error.helper";

describe("authErrorMessage", () => {
  test("should have a Turkish sentence of its own for every code", () => {
    const messages = AUTH_ERROR_CODES.map((code) => authErrorMessage(code));
    expect(new Set(messages).size).toBe(AUTH_ERROR_CODES.length);
    for (const message of messages) {
      expect(message).toMatch(/^[A-ZÇĞİÖŞÜ].+\.$/);
    }
  });

  test("should keep the sentences a screen shows", () => {
    expect(authErrorMessage("SIGN_IN_CANCELLED")).toBe("Giriş iptal edildi.");
    expect(authErrorMessage("OFFLINE")).toBe(
      "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip yeniden deneyin."
    );
    expect(authErrorMessage("NOT_A_CUSTOMER")).toBe(
      "Programlara müşteri hesabıyla giriş yapılır."
    );
  });

  test.each([
    [1, "1 saniye"],
    [0.2, "1 saniye"],
    [45, "45 saniye"],
    [59.5, "60 saniye"],
    [60, "1 dakika"],
    [61, "2 dakika"],
    [900, "15 dakika"],
  ])(
    "should tell a rate-limited customer to wait %d seconds as %s",
    (seconds, wait) => {
      expect(authErrorMessage("RATE_LIMITED", seconds)).toBe(
        `Çok fazla deneme yapıldı. ${wait} sonra yeniden deneyin.`
      );
    }
  );

  test.each([undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "should fall back to the sentence without a wait for %s seconds",
    (seconds) => {
      expect(authErrorMessage("RATE_LIMITED", seconds)).toBe(
        "Çok fazla deneme yapıldı. Biraz sonra yeniden deneyin."
      );
    }
  );

  test("should use the wait for a rate limit only", () => {
    expect(authErrorMessage("OFFLINE", 30)).toBe(authErrorMessage("OFFLINE"));
  });
});

describe("createAuthError", () => {
  test("should carry the code and its sentence", () => {
    expect(createAuthError("CODE_REFUSED")).toEqual({
      code: "CODE_REFUSED",
      message: "Giriş kodu geçersiz ya da süresi dolmuş. Yeniden giriş yapın.",
    });
  });

  test("should carry the wait when there is one", () => {
    expect(createAuthError("RATE_LIMITED", 120)).toEqual({
      code: "RATE_LIMITED",
      message: "Çok fazla deneme yapıldı. 2 dakika sonra yeniden deneyin.",
      retryAfterSeconds: 120,
    });
  });
});
