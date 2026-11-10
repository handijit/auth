import { defineContract } from "@handijit/electron";
import { describe, expect, test, vi } from "vitest";

import createAuth from "../../lib/main/create-auth";
import type { AuthHost } from "../../lib/main/create-auth";
import {
  authContract,
  authStateSchema,
  signInResultSchema,
} from "../../lib/shared/auth-contract";
import { electronMock } from "../support/electron";
import { CUSTOMER, rawRequest } from "../support/fake-browser";
import useAuthHarness, { until } from "../support/harness";

vi.mock("electron", async () => {
  const { electronMock: mock } = await import("../support/electron");
  return mock;
});

const USER = { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" };
const SIGNED_OUT = {
  status: "signed-out",
  user: null,
  error: null,
  isRemembered: false,
};
const SIGNING_IN = { ...SIGNED_OUT, status: "signing-in" };
const SIGNED_IN = {
  status: "signed-in",
  user: USER,
  error: null,
  isRemembered: true,
};

const h = useAuthHarness();

/** The part of an app's context that `attach` uses, recorded. */
const createHost = (): {
  host: AuthHost;
  broadcast: ReturnType<typeof vi.fn>;
  showWindow: ReturnType<typeof vi.fn>;
} => {
  const broadcast = vi.fn();
  const showWindow = vi.fn();
  return {
    host: { emitter: { broadcast }, showWindow },
    broadcast,
    showWindow,
  };
};

/** What an IPC handler receives besides the input; the handlers of this package never read it. */
const EVENT = {} as never;

describe("createAuth: options", () => {
  test.each([
    ["empty", ""],
    ["with an upper-case letter", "Notlar"],
    ["with a doubled hyphen", "not--lar"],
    ["with a leading hyphen", "-notlar"],
    ["with a space", "not lar"],
    ["longer than 64 characters", "a".repeat(65)],
    ["not a string", 7],
    ["missing", undefined],
  ])("should refuse a product that is %s", (_name, product) => {
    expect(() => createAuth({ product: product as string })).toThrow(
      new TypeError(
        `createAuth: options.product must be the program's slug (a-z, 0-9 and "-", at most 64 characters), received ${JSON.stringify(product)}`
      )
    );
  });

  test.each(["notlar", "on-muhasebe", "a", "a".repeat(64), "crm2"])(
    "should accept the product %s",
    (product) => {
      expect(() => createAuth({ product })).not.toThrow();
    }
  );

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "should refuse a time limit of %s",
    (signInTimeoutMs) => {
      expect(() => createAuth({ product: "notlar", signInTimeoutMs })).toThrow(
        new TypeError(
          `createAuth: options.signInTimeoutMs must be a number of milliseconds above zero, received ${String(signInTimeoutMs)}`
        )
      );
    }
  );

  test("should refuse a site address that is not one", () => {
    expect(() =>
      createAuth({ product: "notlar", panelBaseUrl: "handijit.com" })
    ).toThrow(TypeError);
  });

  test("should work without a logger", async () => {
    const auth = h.create({ logger: undefined });
    auth.onChange(() => {
      throw new Error("A listener that fails");
    });
    h.api.setOffline(true);

    // Both levels are reached: a failing listener warns, an unreachable backend informs.
    expect(await h.signInAs(auth)).toMatchObject({
      ok: false,
      error: { code: "OFFLINE" },
    });
    h.api.setOffline(false);
    await h.signInAs(auth);
    h.api.setOffline(true);
    await expect(auth.signOut()).resolves.toBeUndefined();
  });

  test("should open the browser through Electron's shell by default", async () => {
    const auth = h.create();
    await h.signInAs(auth);

    expect(electronMock.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith(
      h.browser.visits[0]?.url.href
    );
  });
});

describe("createAuth: onChange", () => {
  test("should report every change, in order, with the state that getState answers", async () => {
    const auth = h.create();
    const seen = h.record(auth);
    const current: unknown[] = [];
    auth.onChange(() => current.push(auth.getState()));

    await h.signInAs(auth);
    await auth.signOut();

    expect(seen).toEqual([SIGNED_OUT, SIGNING_IN, SIGNED_IN, SIGNED_OUT]);
    expect(current).toEqual(seen);
  });

  test("should stop reporting to a listener that was removed, and only to that one", async () => {
    const auth = h.create();
    const first = vi.fn();
    const second = vi.fn();
    const stop = auth.onChange(first);
    auth.onChange(second);

    await auth.restore();
    stop();
    stop();
    await h.signInAs(auth);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(3);
  });

  test("should keep going when a listener throws, and log it", async () => {
    const auth = h.create();
    auth.onChange(() => {
      throw new Error("The window is gone");
    });
    const seen = h.record(auth);

    expect(await h.signInAs(auth)).toEqual({ ok: true, user: USER });

    expect(seen).toHaveLength(3);
    expect(h.logger.warn).toHaveBeenCalledWith(
      "A listener of the session state failed",
      { reason: "The window is gone" }
    );
  });

  test("should let a listener remove itself while it is being called", async () => {
    const auth = h.create();
    const seen: string[] = [];
    const stop = auth.onChange((state) => {
      seen.push(state.status);
      stop();
    });
    const others = h.record(auth);

    await h.signInAs(auth);

    expect(seen).toEqual(["signed-out"]);
    expect(others).toHaveLength(3);
  });
});

describe("createAuth: attach", () => {
  test("should read the stored session and send every change to the windows", async () => {
    const { host, broadcast } = createHost();
    const auth = h.create();

    auth.attach(host);
    await until(() => broadcast.mock.calls.length === 1, "the first state");
    await h.signInAs(auth);
    await auth.signOut();

    expect(broadcast.mock.calls).toEqual([
      ["auth:changed", SIGNED_OUT],
      ["auth:changed", SIGNING_IN],
      ["auth:changed", SIGNED_IN],
      ["auth:changed", SIGNED_OUT],
    ]);
  });

  test("should send only what the contract allows", async () => {
    const { host, broadcast } = createHost();
    const auth = h.create();
    auth.attach(host);
    await h.signInAs(auth);

    for (const [, payload] of broadcast.mock.calls) {
      expect(authStateSchema.strict().parse(payload)).toEqual(payload);
    }
  });

  test("should bring the window to the front, past the browser, when the browser comes back", async () => {
    const { host, showWindow } = createHost();
    const auth = h.create();
    auth.attach(host);

    const pending = auth.signIn();
    const visit = await h.browser.visit();
    expect(showWindow).not.toHaveBeenCalled();
    await visit.approve();
    await pending;

    expect(showWindow).toHaveBeenCalledTimes(1);
    expect(electronMock.app.focus).toHaveBeenCalledTimes(1);
    expect(electronMock.app.focus).toHaveBeenCalledWith({ steal: true });
  });

  test("should call the program's own hook as well", async () => {
    const onCallback = vi.fn();
    const { host, showWindow } = createHost();
    const auth = h.create({ onCallback });
    auth.attach(host);
    await h.signInAs(auth);

    expect(onCallback).toHaveBeenCalledTimes(1);
    expect(showWindow).toHaveBeenCalledTimes(1);
  });

  test("should not bring the window to the front for a request that is not the callback", async () => {
    const { host, showWindow } = createHost();
    const auth = h.create();
    auth.attach(host);
    const pending = auth.signIn();
    const visit = await h.browser.visit();

    await rawRequest(`${visit.redirectUri}?code=abc&state=wrong`);
    await rawRequest(new URL("/favicon.ico", visit.redirectUri).href);
    expect(showWindow).not.toHaveBeenCalled();

    auth.cancelSignIn();
    await pending;
    expect(showWindow).not.toHaveBeenCalled();
  });

  test("should stop both once it is undone", async () => {
    const { host, broadcast, showWindow } = createHost();
    const auth = h.create();
    const detach = auth.attach(host);
    await until(() => broadcast.mock.calls.length === 1, "the first state");

    detach();
    detach();
    await h.signInAs(auth);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(showWindow).not.toHaveBeenCalled();
    expect(electronMock.app.focus).not.toHaveBeenCalled();
    // The session itself goes on.
    expect(auth.getState()).toEqual(SIGNED_IN);
  });
});

describe("createAuth: the IPC handlers", () => {
  test("should have one handler per request of the contract", () => {
    const auth = h.create();
    expect(Object.keys(auth.handlers).sort()).toEqual(
      Object.keys(authContract.invoke).sort()
    );
  });

  test("should fit an app's contract that includes the fragment", () => {
    const contract = defineContract({
      invoke: { ...authContract.invoke },
      events: { ...authContract.events },
    });
    expect(Object.keys(contract.invoke)).toEqual(
      Object.keys(h.create().handlers)
    );
  });

  test("should answer auth:get-state with the restored state", async () => {
    const auth = h.create();
    const answer = await auth.handlers["auth:get-state"](undefined, EVENT);

    expect(answer).toEqual(SIGNED_OUT);
    expect(authStateSchema.strict().parse(answer)).toEqual(answer);
  });

  test("should run a whole sign-in and sign-out through the handlers", async () => {
    const auth = h.create();

    const pending = auth.handlers["auth:sign-in"](undefined, EVENT);
    const visit = await h.browser.visit();
    await visit.approve();
    const result = await pending;

    expect(result).toEqual({ ok: true, user: USER });
    expect(signInResultSchema.parse(result)).toEqual(result);
    expect(await auth.handlers["auth:get-state"](undefined, EVENT)).toEqual(
      SIGNED_IN
    );

    await auth.handlers["auth:sign-out"](undefined, EVENT);
    expect(auth.getState()).toEqual(SIGNED_OUT);
  });

  test("should answer a failed sign-in in the shape of the contract", async () => {
    h.api.rateLimit(120);
    const auth = h.create();
    const pending = auth.handlers["auth:sign-in"](undefined, EVENT);
    const visit = await h.browser.visit();
    await visit.approve();
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: expect.any(String),
        retryAfterSeconds: 120,
      },
    });
    expect(signInResultSchema.parse(result)).toEqual(result);
  });

  test("should cancel a waiting sign-in through auth:cancel-sign-in, answering nothing", async () => {
    const auth = h.create();
    const pending = auth.handlers["auth:sign-in"](undefined, EVENT);
    await h.browser.visit();

    expect(
      auth.handlers["auth:cancel-sign-in"](undefined, EVENT)
    ).toBeUndefined();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "SIGN_IN_CANCELLED" },
    });
  });
});

describe("createAuth: dispose", () => {
  test("should end a waiting sign-in and free the port", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();

    await auth.dispose();

    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "SIGN_IN_CANCELLED" },
    });
    await expect(rawRequest(visit.redirectUri)).rejects.toThrow();
  });

  test("should close a listener that is still serving its page", async () => {
    const auth = h.create();
    const pending = auth.signIn();
    const visit = await h.browser.visit();
    // The browser asked for the callback and never followed the redirect.
    const code = h.api.authorize({
      user: CUSTOMER,
      codeChallenge: visit.codeChallenge,
      redirectUri: visit.redirectUri,
    });
    const answer = await rawRequest(
      `${visit.redirectUri}?code=${code}&state=${visit.state}`
    );
    expect(answer.status).toBe(303);
    await pending;

    await auth.dispose();

    await expect(rawRequest(visit.redirectUri)).rejects.toThrow();
  });

  test("should report nothing afterwards", async () => {
    const { host, broadcast, showWindow } = createHost();
    const auth = h.create();
    const seen = h.record(auth);
    auth.attach(host);
    await auth.restore();
    seen.length = 0;
    broadcast.mockClear();

    await auth.dispose();
    await h.signInAs(auth);

    expect(seen).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
    expect(showWindow).not.toHaveBeenCalled();
  });

  test("should be safe on a session that was never used, and twice", async () => {
    const auth = h.create();
    await auth.dispose();
    await auth.dispose();

    expect(h.api.requests).toHaveLength(0);
    expect(auth.getState().status).toBe("loading");
  });
});
