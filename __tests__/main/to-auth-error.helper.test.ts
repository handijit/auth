import { createApiClient } from "@handijit/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import toAuthError from "../../lib/main/to-auth-error.helper";
import startFakeApi from "../support/fake-api";
import type { FakeApi } from "../support/fake-api";

// The errors are the real ones: the client of @handijit/core against a server that answers
// the way the backend does.

const EXCHANGE = {
  code: "c".repeat(43),
  codeVerifier: "v".repeat(43),
  redirectUri: "http://127.0.0.1:50000/callback",
};

let api: FakeApi;

const failureOf = async (
  timeoutMs?: number
): Promise<ReturnType<typeof toAuthError>> => {
  const client = createApiClient({ baseUrl: api.url });
  try {
    await client.exchangeDesktopCode(EXCHANGE, { timeoutMs });
  } catch (error) {
    return toAuthError(error);
  }
  throw new Error("The exchange was expected to fail");
};

beforeEach(async () => {
  api = await startFakeApi();
});

afterEach(async () => {
  await api.close();
});

describe("toAuthError", () => {
  test("should read the backend's one refusal of a code as CODE_REFUSED", async () => {
    expect(await failureOf()).toEqual({
      code: "CODE_REFUSED",
      message: "Giriş kodu geçersiz ya da süresi dolmuş. Yeniden giriş yapın.",
    });
  });

  test("should carry the wait of a 429", async () => {
    api.rateLimit(840);
    expect(await failureOf()).toEqual({
      code: "RATE_LIMITED",
      message: "Çok fazla deneme yapıldı. 14 dakika sonra yeniden deneyin.",
      retryAfterSeconds: 840,
    });
  });

  test("should read a connection that drops as OFFLINE", async () => {
    api.setOffline(true);
    expect((await failureOf()).code).toBe("OFFLINE");
  });

  test("should read an answer that does not come in time as OFFLINE", async () => {
    const release = api.hold("/api/public/desktop/token");
    expect((await failureOf(30)).code).toBe("OFFLINE");
    release();
  });

  test("should read an answer that is not the API's as UNEXPECTED", async () => {
    api.breakNext("/api/public/desktop/token", 502);
    expect((await failureOf()).code).toBe("UNEXPECTED");
  });

  test("should read anything that is not an API error as UNEXPECTED", () => {
    expect(toAuthError(new Error("boom")).code).toBe("UNEXPECTED");
    expect(toAuthError(undefined).code).toBe("UNEXPECTED");
  });
});
