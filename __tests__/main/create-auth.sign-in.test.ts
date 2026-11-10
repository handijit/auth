import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

import { describe, expect, test, vi } from "vitest";

import { electronMock } from "../support/electron";
import { CUSTOMER, rawRequest } from "../support/fake-browser";
import createFakeBrowser from "../support/fake-browser";
import useAuthHarness, { until } from "../support/harness";

vi.mock("electron", async () => {
  const { electronMock: mock } = await import("../support/electron");
  return mock;
});

const USER = { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" };
const EXCHANGE_PATH = "/api/public/desktop/token";
const OS_NAME = { darwin: "macOS", win32: "Windows", linux: "Linux" }[
  process.platform as "darwin" | "win32" | "linux"
];

const h = useAuthHarness();

describe("createAuth: a sign-in that succeeds", () => {
  test("should open the consent page on the www host with a request only this attempt can finish", async () => {
    const auth = h.create();
    void auth.signIn();
    const visit = await h.browser.visit();

    expect(visit.url.origin).toBe("https://www.handijit.com");
    expect(visit.url.pathname).toBe("/panel/masaustu-giris");
    expect([...visit.url.searchParams.keys()]).toEqual([
      "product",
      "code_challenge",
      "redirect_uri",
      "state",
    ]);
    expect(visit.product).toBe("notlar");
    expect(visit.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(visit.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d{4,5}\/callback$/
    );
    // 128 bits of randomness from core.
    expect(visit.state).toMatch(/^[A-Za-z0-9_-]{22,200}$/);
    expect(electronMock.shell.openExternal).toHaveBeenCalledExactlyOnceWith(
      visit.url.href
    );
  });

  test("should sign the customer in once the browser comes back", async () => {
    const auth = h.create();
    const seen = h.record(auth);

    const result = await h.signInAs(auth);

    expect(result).toEqual({ ok: true, user: USER });
    expect(auth.getState()).toEqual({
      status: "signed-in",
      user: USER,
      error: null,
      isRemembered: true,
    });
    expect(seen.map((state) => state.status)).toEqual([
      "signed-out",
      "signing-in",
      "signed-in",
    ]);
  });

  test("should exchange the code once, with the verifier of the challenge and the same redirect address", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    const { code } = await visit.approve();
    await pending;

    const exchanges = h.api.requests.filter(
      (request) => request.path === EXCHANGE_PATH
    );
    expect(exchanges).toHaveLength(1);
    const body = exchanges[0]?.body as {
      code: string;
      codeVerifier: string;
      redirectUri: string;
    };
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "codeVerifier",
      "redirectUri",
    ]);
    expect(body.code).toBe(code);
    expect(body.redirectUri).toBe(visit.redirectUri);
    expect(body.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(
      createHash("sha256").update(body.codeVerifier).digest("base64url")
    ).toBe(visit.codeChallenge);
  });

  test("should name the program and the machine to the backend, which stores it as the device", async () => {
    const auth = h.create();
    await h.signInAs(auth);

    const expected = `notlar/1.4.0 (${OS_NAME} 15.1.0; ${process.arch})`;
    expect(h.api.sessions[0]?.userAgent).toBe(expected);
    expect(
      h.api.requests.every((request) => request.userAgent === expected)
    ).toBe(true);
  });

  test("should send the User-Agent it was given", async () => {
    const auth = h.create({ userAgent: "Han Not/2.0 (test)" });
    await h.signInAs(auth);
    expect(h.api.sessions[0]?.userAgent).toBe("Han Not/2.0 (test)");
  });

  test("should send the browser on to the code-free page", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    const { callback, page } = await visit.approve();
    await pending;

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe("/tamamlandi");
    expect(page?.status).toBe(200);
    expect(page?.body).toContain("Programa dönebilirsiniz");
  });

  test("should keep the tokens to itself: not in a state, not in the outcome, not in the log", async () => {
    const auth = h.create();
    const seen = h.record(auth);
    const result = await h.signInAs(auth);

    const session = h.api.sessions[0];
    const visible =
      JSON.stringify([seen, result, auth.getState()]) + h.logged();
    expect(session?.refreshToken).toMatch(/.{20,}/);
    expect(visible).not.toContain(session?.refreshToken);
    expect(visible).not.toContain(session?.accessToken);
  });

  test("should store the session encrypted, never the access token", async () => {
    const auth = h.create();
    await h.signInAs(auth);

    const session = h.api.sessions[0];
    const bytes = h.storedBytes();
    expect(bytes).not.toContain(session?.refreshToken);
    expect(bytes).not.toContain(USER.email);
    const stored = await electronMock.safeStorage.decryptStringAsync(
      Buffer.from(bytes, "latin1")
    );
    expect(JSON.parse(stored.result)).toEqual({
      v: 1,
      refreshToken: session?.refreshToken,
      user: USER,
    });
  });

  test("should tell the program the moment the browser is back, before the exchange has answered", async () => {
    const onCallback = vi.fn();
    const auth = h.create({ onCallback });
    const release = h.api.hold(EXCHANGE_PATH);
    const pending = auth.signIn();
    const visit = await h.browser.visit();

    expect(onCallback).not.toHaveBeenCalled();
    await visit.approve();
    await until(() => h.api.countOf(EXCHANGE_PATH) === 1, "the exchange");
    expect(onCallback).toHaveBeenCalledTimes(1);
    expect(auth.getState().status).toBe("signing-in");

    release();
    expect((await pending).ok).toBe(true);
    expect(onCallback).toHaveBeenCalledTimes(1);
  });

  test("should finish the sign-in even when the program's hook throws", async () => {
    const auth = h.create({
      onCallback: () => {
        throw new Error("no window");
      },
    });
    expect((await h.signInAs(auth)).ok).toBe(true);
    expect(h.logger.warn).toHaveBeenCalledWith("The callback hook failed", {
      reason: "no window",
    });
  });

  test("should answer at once, without the browser, when the customer is already signed in", async () => {
    const auth = h.create();
    await h.signInAs(auth);

    expect(await auth.signIn()).toEqual({ ok: true, user: USER });
    expect(h.browser.visits).toHaveLength(1);
    expect(h.api.countOf(EXCHANGE_PATH)).toBe(1);
  });

  test("should open the site it was given", async () => {
    const panelBaseUrl = "http://127.0.0.1:3100/";
    h.browser = createFakeBrowser(h.api, "http://127.0.0.1:3100");
    const auth = h.create({ panelBaseUrl, openBrowser: h.browser.open });

    expect((await h.signInAs(auth)).ok).toBe(true);
    expect(h.browser.visits[0]?.url.origin).toBe("http://127.0.0.1:3100");
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });

  test("should listen on the port it was given", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => {
      probe.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });

    const auth = h.create({ port });
    void auth.signIn();
    const visit = await h.browser.visit();
    expect(visit.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
  });

  test("should not be disturbed by what a real browser also asks for", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    const origin = new URL(visit.redirectUri).origin;

    expect((await rawRequest(`${origin}/favicon.ico`)).status).toBe(404);
    expect(
      (await rawRequest(`${visit.redirectUri}?code=x&state=wrong`)).status
    ).toBe(400);
    expect(auth.getState().status).toBe("signing-in");

    await visit.approve();
    expect((await pending).ok).toBe(true);
  });

  test("should use a new verifier, state and listener for every attempt", async () => {
    const auth = h.create();
    void auth.signIn();
    const first = await h.browser.visit(0);
    auth.cancelSignIn();
    await until(() => auth.getState().status === "signed-out", "the cancel");

    void auth.signIn();
    const second = await h.browser.visit(1);
    expect(second.state).not.toBe(first.state);
    expect(second.codeChallenge).not.toBe(first.codeChallenge);
  });
});

describe("createAuth: a second signIn while one is waiting", () => {
  test("should reopen the same page on the same listener and share the outcome", async () => {
    const auth = h.create();
    const first = auth.signIn();
    const visit = await h.browser.visit(0);

    const second = auth.signIn();
    const again = await h.browser.visit(1);

    expect(second).toBe(first);
    expect(again.url.href).toBe(visit.url.href);

    await again.approve();
    expect(await first).toEqual({ ok: true, user: USER });
    expect(h.api.countOf(EXCHANGE_PATH)).toBe(1);
    expect(h.browser.visits).toHaveLength(2);
  });

  test("should open nothing twice when the first has not reached the browser yet", async () => {
    const auth = h.create();
    const first = auth.signIn();
    const second = auth.signIn();
    expect(second).toBe(first);

    const visit = await h.browser.visit(0);
    await visit.approve();
    await first;
    expect(h.browser.visits).toHaveLength(1);
  });

  test("should keep waiting when the page cannot be reopened", async () => {
    let calls = 0;
    const auth = h.create({
      openBrowser: async (url) => {
        calls += 1;
        if (calls === 2) throw new Error("no browser");
        await h.browser.open(url);
      },
    });
    const first = auth.signIn();
    const visit = await h.browser.visit(0);
    void auth.signIn();
    await until(() => calls === 2, "the second opening");
    await until(() => h.logger.warn.mock.calls.length === 1, "the warning");

    await visit.approve();
    expect((await first).ok).toBe(true);
  });
});

describe("createAuth: cancel", () => {
  const CANCELLED = {
    ok: false,
    error: { code: "SIGN_IN_CANCELLED", message: "Giriş iptal edildi." },
  };

  test("should end the wait with SIGN_IN_CANCELLED and close the listener", async () => {
    const auth = h.create();
    const seen = h.record(auth);
    const pending = auth.signIn();
    const visit = await h.browser.visit();

    auth.cancelSignIn();

    expect(await pending).toEqual(CANCELLED);
    // The customer's own choice is not an error to show.
    expect(auth.getState()).toEqual({
      status: "signed-out",
      user: null,
      error: null,
      isRemembered: false,
    });
    expect(seen.map((state) => state.status)).toEqual([
      "signed-out",
      "signing-in",
      "signed-out",
    ]);
    await expect(rawRequest(visit.redirectUri)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    expect(h.api.requests).toHaveLength(0);
  });

  test("should do nothing when no sign-in is waiting", async () => {
    const auth = h.create();
    auth.cancelSignIn();
    expect(auth.getState().status).toBe("loading");

    // And it does not cancel the next one in advance.
    expect((await h.signInAs(auth)).ok).toBe(true);
  });

  test("should not open the browser when the cancel comes before the listener is up", async () => {
    const auth = h.create();
    const seen = h.record(auth);
    const pending = auth.signIn();
    auth.cancelSignIn();

    expect(await pending).toEqual(CANCELLED);
    expect(h.browser.visits).toHaveLength(0);
    expect(seen.map((state) => state.status)).toEqual(["signed-out"]);
  });

  test("should not open the browser when the cancel comes while the listener starts", async () => {
    const auth = h.create();
    auth.onChange((state) => {
      if (state.status === "signing-in") auth.cancelSignIn();
    });

    expect(await auth.signIn()).toEqual(CANCELLED);
    expect(h.browser.visits).toHaveLength(0);
    expect(auth.getState().status).toBe("signed-out");
  });

  test("should work while the browser is still being opened", async () => {
    const auth = h.create({ openBrowser: () => new Promise(() => undefined) });
    const pending = auth.signIn();
    await until(() => auth.getState().status === "signing-in", "the attempt");
    auth.cancelSignIn();
    expect(await pending).toEqual(CANCELLED);
  });

  test("should end the session the backend handed out when the cancel comes during the exchange", async () => {
    const auth = h.create();
    const release = h.api.hold(EXCHANGE_PATH);
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    await visit.approve();
    await until(() => h.api.countOf(EXCHANGE_PATH) === 1, "the exchange");

    auth.cancelSignIn();
    release();

    expect(await pending).toEqual(CANCELLED);
    expect(auth.getState().status).toBe("signed-out");
    expect(auth.getState().error).toBeNull();
    expect(h.api.sessions).toHaveLength(1);
    expect(h.api.sessions[0]?.isRevoked).toBe(true);
    expect(h.hasStoredSession()).toBe(false);
  });

  test("should stay a cancel when the exchange it interrupted fails", async () => {
    const auth = h.create();
    const release = h.api.hold(EXCHANGE_PATH);
    h.api.loseNextAnswer(EXCHANGE_PATH);
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    await visit.approve();
    await until(() => h.api.countOf(EXCHANGE_PATH) === 1, "the exchange");

    auth.cancelSignIn();
    release();

    expect(await pending).toEqual(CANCELLED);
    expect(auth.getState().error).toBeNull();
  });

  test("should let the customer sign in again afterwards", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    await h.browser.visit();
    auth.cancelSignIn();
    await pending;

    expect(await h.signInAs(auth)).toEqual({ ok: true, user: USER });
  });
});

describe("createAuth: the time limit", () => {
  const TIMED_OUT = {
    ok: false,
    error: {
      code: "SIGN_IN_TIMED_OUT",
      message: "Giriş zamanında tamamlanmadı. Yeniden deneyin.",
    },
  };

  test("should give up after ten minutes by default and close the listener", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();

    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(auth.getState().status).toBe("signing-in");
    expect((await rawRequest(visit.redirectUri)).status).toBe(400);

    vi.advanceTimersByTime(1);
    expect(await pending).toEqual(TIMED_OUT);
    expect(auth.getState()).toEqual({
      status: "signed-out",
      user: null,
      error: TIMED_OUT.error,
      isRemembered: false,
    });
    await expect(rawRequest(visit.redirectUri)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });

  test("should use the limit it was given", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const auth = h.create({ signInTimeoutMs: 30_000 });
    const pending = auth.signIn();
    await h.browser.visit();

    vi.advanceTimersByTime(29_999);
    expect(auth.getState().status).toBe("signing-in");
    vi.advanceTimersByTime(1);
    expect(await pending).toEqual(TIMED_OUT);
  });

  test("should clear the error when the customer tries again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const auth = h.create({ signInTimeoutMs: 1_000 });
    const pending = auth.signIn();
    await h.browser.visit(0);
    vi.advanceTimersByTime(1_000);
    await pending;
    expect(auth.getState().error?.code).toBe("SIGN_IN_TIMED_OUT");

    void auth.signIn();
    await h.browser.visit(1);
    expect(auth.getState()).toEqual({
      status: "signing-in",
      user: null,
      error: null,
      isRemembered: false,
    });
  });
});

describe("createAuth: a sign-in that fails", () => {
  test("should stop with STATE_MISMATCH when the port is flooded, not before", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    const wrong = `${visit.redirectUri}?code=x&state=not-ours`;

    for (let index = 0; index < 19; index++) await rawRequest(wrong);
    expect(auth.getState().status).toBe("signing-in");
    await rawRequest(wrong);

    expect(await pending).toEqual({
      ok: false,
      error: {
        code: "STATE_MISMATCH",
        message:
          "Giriş doğrulanamadı. Güvenliğiniz için işlem durduruldu; yeniden deneyin.",
      },
    });
    expect(auth.getState().error?.code).toBe("STATE_MISMATCH");
    expect(h.api.requests).toHaveLength(0);
    await expect(rawRequest(wrong)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });

  test("should report CODE_REFUSED for a code the backend does not accept, without a second try", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    // A code issued for another program's challenge, delivered with the right state.
    const code = h.api.authorize({
      user: CUSTOMER,
      codeChallenge: "another-challenge",
      redirectUri: visit.redirectUri,
    });
    await rawRequest(`${visit.redirectUri}?code=${code}&state=${visit.state}`);

    expect(await pending).toEqual({
      ok: false,
      error: {
        code: "CODE_REFUSED",
        message:
          "Giriş kodu geçersiz ya da süresi dolmuş. Yeniden giriş yapın.",
      },
    });
    expect(h.api.countOf(EXCHANGE_PATH)).toBe(1);
    expect(auth.getState().status).toBe("signed-out");
    expect(h.hasStoredSession()).toBe(false);
  });

  test("should report CODE_REFUSED for a code that is older than a minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    const code = h.api.authorize({
      user: CUSTOMER,
      codeChallenge: visit.codeChallenge,
      redirectUri: visit.redirectUri,
    });
    vi.advanceTimersByTime(60_000);
    await rawRequest(`${visit.redirectUri}?code=${code}&state=${visit.state}`);

    expect((await pending).ok).toBe(false);
    expect(auth.getState().error?.code).toBe("CODE_REFUSED");
  });

  test("should report NOT_A_CUSTOMER when the backend refuses a proven code for the account", async () => {
    const auth = h.create();
    const result = await h.signInAs(auth, { ...CUSTOMER, role: "ADMIN" });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_A_CUSTOMER",
        message: "Programlara müşteri hesabıyla giriş yapılır.",
      },
    });
    expect(auth.getState().status).toBe("signed-out");
    expect(h.hasStoredSession()).toBe(false);
  });

  test("should refuse a session for an account that is not a customer, and end it at the backend", async () => {
    h.api.skipRoleCheck();
    const auth = h.create();
    const result = await h.signInAs(auth, { ...CUSTOMER, role: "ADMIN" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_A_CUSTOMER",
        message: "Programlara müşteri hesabıyla giriş yapılır.",
      },
    });
    expect(auth.getState().status).toBe("signed-out");
    expect(h.api.sessions[0]?.isRevoked).toBe(true);
    expect(h.hasStoredSession()).toBe(false);
  });

  test("should report RATE_LIMITED with the seconds to wait", async () => {
    h.api.rateLimit(840);
    const auth = h.create();
    const result = await h.signInAs(auth);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Çok fazla deneme yapıldı. 14 dakika sonra yeniden deneyin.",
        retryAfterSeconds: 840,
      },
    });
    expect(auth.getState().error).toEqual((result as { error: unknown }).error);
    expect(h.api.countOf(EXCHANGE_PATH)).toBe(1);
  });

  test("should report OFFLINE when the backend cannot be reached, without sending the code twice", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    h.api.setOffline(true);
    await visit.approve();

    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "OFFLINE" },
    });
    expect(h.api.countOf(EXCHANGE_PATH)).toBe(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      "The sign-in code could not be exchanged",
      { reason: expect.any(String) }
    );
  });

  test("should report UNEXPECTED for an answer that is not the API's", async () => {
    h.api.breakNext(EXCHANGE_PATH, 502);
    const auth = h.create();
    expect(await h.signInAs(auth)).toMatchObject({
      ok: false,
      error: { code: "UNEXPECTED" },
    });
  });

  test("should never log the code, the verifier or the state", async () => {
    h.api.breakNext(EXCHANGE_PATH, 502);
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    const { code } = await visit.approve();
    await pending;

    const body = h.api.requests[0]?.body as { codeVerifier: string };
    const logged = h.logged();
    expect(h.logger.warn).toHaveBeenCalled();
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(body.codeVerifier);
    expect(logged).not.toContain(visit.state);
  });

  test.each([
    ["rejects", () => Promise.reject(new Error("no handler for https"))],
    [
      "throws",
      () => {
        throw new Error("no handler for https");
      },
    ],
  ])(
    "should report BROWSER_NOT_OPENED when the opener %s, and close the listener",
    async (_name, openBrowser) => {
      const auth = h.create({ openBrowser });
      expect(await auth.signIn()).toEqual({
        ok: false,
        error: {
          code: "BROWSER_NOT_OPENED",
          message: "Tarayıcı açılamadı. Yeniden deneyin.",
        },
      });
      expect(auth.getState().error?.code).toBe("BROWSER_NOT_OPENED");
      expect(h.logger.warn).toHaveBeenCalledWith(
        "The browser could not be opened",
        { reason: "no handler for https" }
      );
    }
  );

  test("should report LISTENER_FAILED when the port it was given is taken", async () => {
    const squatter = createServer();
    await new Promise<void>((resolve) => {
      squatter.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const { port } = squatter.address() as AddressInfo;

    const auth = h.create({ port });
    expect(await auth.signIn()).toEqual({
      ok: false,
      error: {
        code: "LISTENER_FAILED",
        message: "Giriş başlatılamadı. Yeniden deneyin.",
      },
    });
    expect(h.browser.visits).toHaveLength(0);
    expect(h.logger.warn).toHaveBeenCalledWith(
      "The loopback listener could not be started",
      { reason: expect.stringContaining("EADDRINUSE") }
    );
    await new Promise<void>((resolve) => {
      squatter.close(() => resolve());
    });
  });

  test("should let the customer try again after a failure", async () => {
    h.api.rateLimit(60);
    const auth = h.create();
    await h.signInAs(auth);
    h.api.rateLimit(null);

    expect(await h.signInAs(auth)).toEqual({ ok: true, user: USER });
    expect(auth.getState().error).toBeNull();
  });
});
