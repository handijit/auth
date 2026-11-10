import { isApiError, isUnauthorized } from "@handijit/core/errors";
import { createSecretStore } from "@handijit/electron/main";
import type { SecretStore } from "@handijit/electron/main";
import { describe, expect, test, vi } from "vitest";

import { control, electronMock } from "../support/electron";
import useAuthHarness, { until } from "../support/harness";

vi.mock("electron", async () => {
  const { electronMock: mock } = await import("../support/electron");
  return mock;
});

const USER = { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" };
const SIGNED_IN = {
  status: "signed-in",
  user: USER,
  error: null,
  isRemembered: true,
};
const SIGNED_OUT = {
  status: "signed-out",
  user: null,
  error: null,
  isRemembered: false,
};
const SESSION_ENDED = {
  code: "SESSION_ENDED",
  message:
    "Oturumunuz başka bir yerden kapatıldı ya da süresi doldu. Yeniden giriş yapın.",
};
const REFRESH_PATH = "/api/auth/refresh";
const LOGOUT_PATH = "/api/auth/logout";
const ME_PATH = "/api/auth/me";

const h = useAuthHarness();

/** The requests to a path, in order. */
const requestsTo = (path: string): (typeof h.api.requests)[number][] =>
  h.api.requests.filter((request) => request.path === path);

/** A program that signed in, as its process ended: only the disk remembers it. */
const signedInBefore = async (): Promise<void> => {
  const previous = h.create();
  await h.signInAs(previous);
  await previous.dispose();
};

/** A secret store whose writes wait until they are let through. */
const gatedStore = (): {
  store: SecretStore;
  isWriting: () => boolean;
  open: () => void;
} => {
  const real = createSecretStore();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let isWriting = false;
  return {
    store: {
      ...real,
      set: async (name, value) => {
        isWriting = true;
        await gate;
        await real.set(name, value);
      },
    },
    isWriting: () => isWriting,
    open,
  };
};

describe("createAuth: before anything is asked of it", () => {
  test("should do nothing on creation: no request, no file, no listener", async () => {
    const auth = h.create();
    await new Promise((resolve) => setImmediate(resolve));

    expect(auth.getState()).toEqual({
      status: "loading",
      user: null,
      error: null,
      isRemembered: false,
    });
    expect(h.api.requests).toHaveLength(0);
    expect(electronMock.app.whenReady).not.toHaveBeenCalled();
    expect(electronMock.net.fetch).not.toHaveBeenCalled();
  });
});

describe("createAuth: restore", () => {
  test("should be signed out on a machine that never signed in", async () => {
    const auth = h.create();
    const seen = h.record(auth);

    expect(await auth.restore()).toEqual(SIGNED_OUT);
    expect(seen).toEqual([SIGNED_OUT]);
    expect(h.api.requests).toHaveLength(0);
  });

  test("should wait for the app to be ready: the key store answers nothing before", async () => {
    let ready!: () => void;
    await signedInBefore();
    electronMock.app.whenReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        })
    );

    const auth = h.create();
    const restored = auth.restore();
    await new Promise((resolve) => setImmediate(resolve));
    expect(auth.getState().status).toBe("loading");

    ready();
    expect(await restored).toEqual(SIGNED_IN);
  });

  test("should read the disk once, however often it is called", async () => {
    await signedInBefore();
    electronMock.app.whenReady.mockClear();
    const auth = h.create();
    const seen = h.record(auth);

    const states = await Promise.all([
      auth.restore(),
      auth.restore(),
      auth.restore(),
    ]);
    await until(() => h.api.sessions.length === 2, "the refresh");

    expect(states).toEqual([SIGNED_IN, SIGNED_IN, SIGNED_IN]);
    expect(electronMock.app.whenReady).toHaveBeenCalledTimes(1);
    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
    expect(seen[0]).toEqual(SIGNED_IN);
  });

  test("should show the customer as signed in before the backend has answered", async () => {
    await signedInBefore();
    const release = h.api.hold(REFRESH_PATH);
    const auth = h.create();

    expect(await auth.restore()).toEqual(SIGNED_IN);
    await until(() => requestsTo(REFRESH_PATH).length === 1, "the refresh");
    expect(auth.getState()).toEqual(SIGNED_IN);
    release();
  });

  test("should renew the session in the background and store the new refresh token", async () => {
    await signedInBefore();
    const first = h.api.sessions[0];
    const auth = h.create();
    await auth.restore();
    await until(() => h.api.sessions.length === 2, "the refresh");
    await auth.client.getCurrentUser();

    // The token of the first process was rotated out; the new one is in use and on the disk.
    expect(requestsTo(REFRESH_PATH)[0]?.body).toEqual({
      refreshToken: first?.refreshToken,
    });
    expect(first?.isRevoked).toBe(true);
    expect(requestsTo(ME_PATH)[0]?.authorization).toBe(
      `Bearer ${h.api.sessions[1]?.accessToken}`
    );
    await auth.dispose();

    const third = h.create();
    expect(await third.restore()).toEqual(SIGNED_IN);
    await until(() => h.api.sessions.length === 3, "the next refresh");
    expect(requestsTo(REFRESH_PATH)[1]?.body).toEqual({
      refreshToken: h.api.sessions[1]?.refreshToken,
    });
  });

  test("should show what the backend knows now once it has answered", async () => {
    await signedInBefore();
    h.api.rename(USER.id, "Ayşe Demir");
    const auth = h.create();
    const seen = h.record(auth);
    await auth.restore();
    await until(() => seen.length === 2, "the renewed session");

    expect(seen[0]?.user?.name).toBe("Ayşe Yılmaz");
    expect(seen[1]).toEqual({
      ...SIGNED_IN,
      user: { ...USER, name: "Ayşe Demir" },
    });
  });

  test("should keep the customer signed in when the program starts without a network", async () => {
    await signedInBefore();
    h.api.setOffline(true);
    const auth = h.create();
    const seen = h.record(auth);

    expect(await auth.restore()).toEqual(SIGNED_IN);
    await until(() => h.logger.info.mock.calls.length === 1, "the failure");

    expect(h.logger.info).toHaveBeenCalledWith(
      "The stored session could not be checked with the backend; staying signed in",
      { reason: expect.any(String) }
    );
    expect(auth.getState()).toEqual(SIGNED_IN);
    expect(seen).toEqual([SIGNED_IN]);
    expect(h.hasStoredSession()).toBe(true);

    // Back online: the first request renews the session with the same stored token.
    h.api.setOffline(false);
    expect(await auth.client.getCurrentUser()).toMatchObject({ id: USER.id });
  });

  test("should keep the customer signed in when the backend is broken", async () => {
    await signedInBefore();
    h.api.breakNext(REFRESH_PATH, 502);
    const auth = h.create();
    await auth.restore();
    await until(() => h.logger.info.mock.calls.length === 1, "the failure");

    expect(auth.getState()).toEqual(SIGNED_IN);
    expect(h.hasStoredSession()).toBe(true);
  });

  test("should sign the customer out, with the reason, when the backend refuses the stored session", async () => {
    await signedInBefore();
    h.api.revokeAll();
    const auth = h.create();
    const seen = h.record(auth);
    await auth.restore();
    await until(() => seen.length === 2, "the refusal");

    expect(seen).toEqual([SIGNED_IN, { ...SIGNED_OUT, error: SESSION_ENDED }]);
    await until(() => !h.hasStoredSession(), "the wipe");

    // The next start is a plain signed-out one.
    const next = h.create();
    expect(await next.restore()).toEqual(SIGNED_OUT);
  });

  test("should be signed out when the stored value is not a session", async () => {
    await createSecretStore().set("auth-session", "{}");
    const auth = h.create();
    expect(await auth.restore()).toEqual(SIGNED_OUT);
    expect(h.hasStoredSession()).toBe(false);
  });

  test("should use the secret store it was given", async () => {
    const values = new Map<string, string>();
    const secretStore: SecretStore = {
      isAvailable: () => Promise.resolve(true),
      get: (name) => Promise.resolve(values.get(name) ?? null),
      set: (name, value) => {
        values.set(name, value);
        return Promise.resolve();
      },
      delete: (name) => {
        values.delete(name);
        return Promise.resolve();
      },
    };
    const auth = h.create({ secretStore });
    await h.signInAs(auth);

    expect([...values.keys()]).toEqual(["auth-session"]);
    expect(h.hasStoredSession()).toBe(false);
    await auth.signOut();
    expect(values.size).toBe(0);
  });
});

describe("createAuth: a machine without a key store", () => {
  test("should keep the session in memory only, and say so", async () => {
    control.isEncryptionAvailable = false;
    const auth = h.create();
    const result = await h.signInAs(auth);

    expect(result).toEqual({ ok: true, user: USER });
    expect(auth.getState()).toEqual({ ...SIGNED_IN, isRemembered: false });
    expect(h.hasStoredSession()).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledWith(
      "The session could not be stored; it lasts until the program closes",
      { reason: expect.any(String) }
    );
    // It works for as long as the program runs.
    expect(await auth.client.getCurrentUser()).toMatchObject({ id: USER.id });
  });

  test("should be signed out after a restart", async () => {
    control.isEncryptionAvailable = false;
    await signedInBefore();
    const auth = h.create();
    expect(await auth.restore()).toEqual(SIGNED_OUT);
  });
});

describe("createAuth: the client for the rest of the program", () => {
  test("should send the access token with a request that asks for it", async () => {
    const auth = h.create();
    await h.signInAs(auth);

    const user = await auth.client.getCurrentUser();

    expect(user).toMatchObject({ id: USER.id, role: "CUSTOMER" });
    expect(requestsTo(ME_PATH)[0]?.authorization).toBe(
      `Bearer ${h.api.sessions[0]?.accessToken}`
    );
    expect(requestsTo(REFRESH_PATH)).toHaveLength(0);
  });

  test("should not carry the calls that would move the session", () => {
    const auth = h.create();
    expect(Object.keys(auth.client)).toEqual(
      expect.arrayContaining(["request", "getCurrentUser", "listSessions"])
    );
    expect(auth.client).not.toHaveProperty("exchangeDesktopCode");
    expect(auth.client).not.toHaveProperty("refresh");
    expect(auth.client).not.toHaveProperty("logout");
  });

  test("should restore and renew the session by itself when it is used first", async () => {
    await signedInBefore();
    const auth = h.create();

    expect(await auth.client.getCurrentUser()).toMatchObject({ id: USER.id });
    expect(auth.getState()).toEqual(SIGNED_IN);
    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
    expect(requestsTo(ME_PATH)).toHaveLength(1);
  });

  test("should share one refresh between the start-up check and the requests that need a token", async () => {
    await signedInBefore();
    const release = h.api.hold(REFRESH_PATH);
    const auth = h.create();
    await auth.restore();
    const answers = Promise.all([
      auth.client.getCurrentUser(),
      auth.client.getCurrentUser(),
      auth.client.getCurrentUser(),
    ]);
    await until(() => requestsTo(REFRESH_PATH).length === 1, "the refresh");
    release();

    expect(await answers).toHaveLength(3);
    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
    expect(h.api.sessions.filter((session) => !session.isRevoked)).toHaveLength(
      1
    );
  });

  test("should renew an access token shortly before it expires, without a refused request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const auth = h.create();
    await h.signInAs(auth);
    const signedInAt = Date.now();

    // Fifteen minutes of life, thirty seconds of margin.
    vi.setSystemTime(signedInAt + 869_999);
    await auth.client.getCurrentUser();
    expect(requestsTo(REFRESH_PATH)).toHaveLength(0);

    vi.setSystemTime(signedInAt + 870_000);
    await auth.client.getCurrentUser();
    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
    expect(requestsTo(ME_PATH).map((request) => request.authorization)).toEqual(
      [
        `Bearer ${h.api.sessions[0]?.accessToken}`,
        `Bearer ${h.api.sessions[1]?.accessToken}`,
      ]
    );
  });

  test("should take half the life as the margin of a very short token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    h.api.setAccessTokenLifetime(10);
    const auth = h.create();
    await h.signInAs(auth);
    const signedInAt = Date.now();

    vi.setSystemTime(signedInAt + 4_999);
    await auth.client.getCurrentUser();
    expect(requestsTo(REFRESH_PATH)).toHaveLength(0);

    vi.setSystemTime(signedInAt + 5_000);
    await auth.client.getCurrentUser();
    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
  });

  test("should refresh once for any number of requests that need it at the same moment", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const auth = h.create();
    await h.signInAs(auth);
    vi.setSystemTime(Date.now() + 900_000);

    await Promise.all(
      Array.from({ length: 6 }, () => auth.client.getCurrentUser())
    );

    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
    expect(requestsTo(ME_PATH)).toHaveLength(6);
    expect(auth.getState()).toEqual(SIGNED_IN);
  });

  test("should have the new refresh token on the disk before the request it renewed for is answered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const auth = h.create();
    await h.signInAs(auth);
    const before = h.storedBytes();
    vi.setSystemTime(Date.now() + 900_000);

    await auth.client.getCurrentUser();

    const stored = await electronMock.safeStorage.decryptStringAsync(
      Buffer.from(h.storedBytes(), "latin1")
    );
    expect(h.storedBytes()).not.toBe(before);
    expect(JSON.parse(stored.result)).toMatchObject({
      refreshToken: h.api.sessions[1]?.refreshToken,
    });
  });

  test("should renew and resend once when the backend refuses a token that looked alive", async () => {
    const auth = h.create();
    await h.signInAs(auth);
    // The access token dies at the backend, the refresh token does not.
    (h.api.sessions[0] as { accessToken: string }).accessToken = "retired";

    expect(await auth.client.getCurrentUser()).toMatchObject({ id: USER.id });
    expect(requestsTo(ME_PATH)).toHaveLength(2);
    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
  });

  test("should end the session, with the reason, when it was ended somewhere else", async () => {
    const auth = h.create();
    await h.signInAs(auth);
    const seen = h.record(auth);
    h.api.revokeAll();

    const failure = await auth.client
      .getCurrentUser()
      .catch((error: unknown) => error);

    expect(isUnauthorized(failure)).toBe(true);
    expect(seen).toEqual([{ ...SIGNED_OUT, error: SESSION_ENDED }]);
    expect(h.hasStoredSession()).toBe(false);
    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
    // Nothing is left to renew with: the next request is refused without another refresh.
    await expect(auth.client.getCurrentUser()).rejects.toSatisfy(
      isUnauthorized
    );
    expect(requestsTo(REFRESH_PATH)).toHaveLength(1);
  });

  test("should stay signed in when a refresh gets no answer, and report the failure to the caller", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const auth = h.create();
    await h.signInAs(auth);
    vi.setSystemTime(Date.now() + 900_000);
    h.api.setOffline(true);

    const failure = await auth.client
      .request({ method: "POST", path: "/api/customer/anything", auth: true })
      .catch((error: unknown) => error);

    expect(isApiError(failure) && failure.kind).toBe("network");
    expect(auth.getState()).toEqual(SIGNED_IN);
    expect(h.hasStoredSession()).toBe(true);

    h.api.setOffline(false);
    expect(await auth.client.getCurrentUser()).toMatchObject({ id: USER.id });
  });

  test("should lose the session when the answer to a refresh is lost: the backend has already rotated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const auth = h.create();
    await h.signInAs(auth);
    vi.setSystemTime(Date.now() + 900_000);
    h.api.loseNextAnswer(REFRESH_PATH);

    await expect(
      auth.client.request({ method: "POST", path: "/api/x", auth: true })
    ).rejects.toMatchObject({ kind: "network" });
    // Still signed in here: nothing said the session is over.
    expect(auth.getState()).toEqual(SIGNED_IN);

    // The next refresh presents the token the backend retired while answering into the void.
    await expect(auth.client.getCurrentUser()).rejects.toSatisfy(
      isUnauthorized
    );
    expect(auth.getState()).toEqual({ ...SIGNED_OUT, error: SESSION_ENDED });
  });

  test("should send a request without a token, and no refresh, when nobody is signed in", async () => {
    const auth = h.create();
    await expect(auth.client.getCurrentUser()).rejects.toSatisfy(
      isUnauthorized
    );

    expect(requestsTo(REFRESH_PATH)).toHaveLength(0);
    expect(requestsTo(ME_PATH)[0]?.authorization).toBeUndefined();
    expect(auth.getState()).toEqual(SIGNED_OUT);
  });

  test("should end the session when a refresh answers for an account that is no longer a customer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const auth = h.create();
    await h.signInAs(auth);
    h.api.setRole(USER.id, "ADMIN");
    vi.setSystemTime(Date.now() + 900_000);

    await expect(auth.client.getCurrentUser()).rejects.toSatisfy(
      isUnauthorized
    );

    expect(auth.getState()).toEqual({
      ...SIGNED_OUT,
      error: {
        code: "NOT_A_CUSTOMER",
        message: "Programlara müşteri hesabıyla giriş yapılır.",
      },
    });
    expect(h.api.sessions.every((session) => session.isRevoked)).toBe(true);
    expect(h.hasStoredSession()).toBe(false);
  });

  test("should use the fetch it was given instead of Electron's", async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) =>
      fetch(url, init)
    );
    const auth = h.create({ fetch: fetchSpy });
    await h.signInAs(auth);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(electronMock.net.fetch).not.toHaveBeenCalled();
  });

  test("should send through Electron's net.fetch by default", async () => {
    const auth = h.create();
    await h.signInAs(auth);
    expect(electronMock.net.fetch).toHaveBeenCalledTimes(1);
    expect(electronMock.net.fetch.mock.calls[0]?.[0]).toBe(
      `${h.api.url}/api/public/desktop/token`
    );
  });
});

describe("createAuth: sign-out", () => {
  test("should wipe the session here and end it at the backend", async () => {
    const auth = h.create();
    await h.signInAs(auth);
    const seen = h.record(auth);

    await auth.signOut();

    expect(seen).toEqual([SIGNED_OUT]);
    expect(h.hasStoredSession()).toBe(false);
    expect(requestsTo(LOGOUT_PATH)).toHaveLength(1);
    expect(requestsTo(LOGOUT_PATH)[0]?.body).toEqual({
      refreshToken: h.api.sessions[0]?.refreshToken,
    });
    expect(h.api.sessions[0]?.isRevoked).toBe(true);
    // The access token is gone from memory too.
    await expect(auth.client.getCurrentUser()).rejects.toSatisfy(
      isUnauthorized
    );
    expect(requestsTo(ME_PATH)[0]?.authorization).toBeUndefined();
  });

  test("should stay signed out after a restart", async () => {
    const auth = h.create();
    await h.signInAs(auth);
    await auth.signOut();

    const next = h.create();
    expect(await next.restore()).toEqual(SIGNED_OUT);
  });

  test("should sign out here even when the backend cannot be told", async () => {
    const auth = h.create();
    await h.signInAs(auth);
    h.api.setOffline(true);

    await auth.signOut();

    expect(auth.getState()).toEqual(SIGNED_OUT);
    expect(h.hasStoredSession()).toBe(false);
    expect(h.logger.info).toHaveBeenCalledWith(
      "The backend could not be told that the session is over",
      { reason: expect.any(String) }
    );
  });

  test("should not wait longer than five seconds for the backend", async () => {
    const auth = h.create();
    await h.signInAs(auth);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const release = h.api.hold(LOGOUT_PATH);
    let isDone = false;

    const signedOut = auth.signOut().then(() => {
      isDone = true;
    });
    await until(() => requestsTo(LOGOUT_PATH).length === 1, "the logout");
    // Signed out here at once; only the promise waits for the backend.
    expect(auth.getState()).toEqual(SIGNED_OUT);
    expect(h.hasStoredSession()).toBe(false);

    vi.advanceTimersByTime(4_999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(isDone).toBe(false);

    vi.advanceTimersByTime(1);
    await signedOut;
    release();
  });

  test("should tell the backend nothing when nobody is signed in", async () => {
    const auth = h.create();
    const seen = h.record(auth);
    await auth.signOut();
    await auth.signOut();

    expect(h.api.requests).toHaveLength(0);
    expect(auth.getState()).toEqual(SIGNED_OUT);
    // One change: from loading to signed out. The second call changed nothing.
    expect(seen).toEqual([SIGNED_OUT]);
  });

  test("should clear an error that was showing", async () => {
    h.api.rateLimit(60);
    const auth = h.create();
    await h.signInAs(auth);
    expect(auth.getState().error?.code).toBe("RATE_LIMITED");

    await auth.signOut();
    expect(auth.getState()).toEqual(SIGNED_OUT);
  });

  test("should end a sign-in that is waiting for the browser", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    await h.browser.visit();

    await auth.signOut();

    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "SIGN_IN_CANCELLED" },
    });
    expect(auth.getState()).toEqual(SIGNED_OUT);
  });

  test("should end the session of a refresh that is still on its way", async () => {
    await signedInBefore();
    const release = h.api.hold(REFRESH_PATH);
    const auth = h.create();
    await auth.restore();
    await until(() => requestsTo(REFRESH_PATH).length === 1, "the refresh");

    const signedOut = auth.signOut();
    // Signed out here before the backend has said anything.
    await until(() => !h.hasStoredSession(), "the wipe");
    expect(auth.getState()).toEqual(SIGNED_OUT);
    release();
    await signedOut;

    // The refresh answered with a new session after the sign-out: it was ended, not adopted.
    expect(h.api.sessions).toHaveLength(2);
    expect(h.api.sessions.every((session) => session.isRevoked)).toBe(true);
    expect(requestsTo(LOGOUT_PATH)[0]?.body).toEqual({
      refreshToken: h.api.sessions[1]?.refreshToken,
    });
    expect(auth.getState()).toEqual(SIGNED_OUT);
    expect(h.hasStoredSession()).toBe(false);
  });

  test("should end the session it knows when the refresh on its way gets no answer", async () => {
    await signedInBefore();
    const release = h.api.hold(REFRESH_PATH);
    h.api.loseNextAnswer(REFRESH_PATH);
    const auth = h.create();
    await auth.restore();
    await until(() => requestsTo(REFRESH_PATH).length === 1, "the refresh");

    const signedOut = auth.signOut();
    release();
    await signedOut;

    expect(requestsTo(LOGOUT_PATH)[0]?.body).toEqual({
      refreshToken: h.api.sessions[0]?.refreshToken,
    });
    expect(auth.getState()).toEqual(SIGNED_OUT);
  });

  test("should stay a plain sign-out when the refresh on its way is refused", async () => {
    await signedInBefore();
    h.api.revokeAll();
    const release = h.api.hold(REFRESH_PATH);
    const auth = h.create();
    await auth.restore();
    await until(() => requestsTo(REFRESH_PATH).length === 1, "the refresh");

    const signedOut = auth.signOut();
    release();
    await signedOut;

    // No "your session ended elsewhere" for a customer who has just signed out.
    expect(auth.getState()).toEqual(SIGNED_OUT);
    expect(requestsTo(LOGOUT_PATH)).toHaveLength(0);
  });

  test("should win over a renewed session that is being written to the disk", async () => {
    await signedInBefore();
    const gated = gatedStore();
    const auth = h.create({ secretStore: gated.store });
    await auth.restore();
    await until(gated.isWriting, "the write of the renewed session");

    const signedOut = auth.signOut();
    gated.open();
    await signedOut;

    expect(auth.getState()).toEqual(SIGNED_OUT);
    expect(h.hasStoredSession()).toBe(false);
    expect(h.api.sessions.every((session) => session.isRevoked)).toBe(true);
  });

  test("should win over a sign-in whose session is being written to the disk", async () => {
    const gated = gatedStore();
    const auth = h.create({ secretStore: gated.store });
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    await visit.approve();
    await until(gated.isWriting, "the write of the new session");

    const signedOut = auth.signOut();
    gated.open();
    await signedOut;

    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "SIGN_IN_CANCELLED" },
    });
    expect(auth.getState()).toEqual(SIGNED_OUT);
    expect(h.hasStoredSession()).toBe(false);
    expect(h.api.sessions[0]?.isRevoked).toBe(true);
  });

  test("should let the customer sign in again", async () => {
    const auth = h.create();
    await h.signInAs(auth);
    await auth.signOut();

    expect(await h.signInAs(auth)).toEqual({ ok: true, user: USER });
    expect(auth.getState()).toEqual(SIGNED_IN);
    expect(h.api.sessions.filter((session) => !session.isRevoked)).toHaveLength(
      1
    );
  });
});
