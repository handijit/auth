import { channelsOf, defineContract } from "@handijit/electron";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import AUTH_CHANNELS from "../../lib/shared/auth-channels.constants";
import {
  authContract,
  authErrorSchema,
  authStateSchema,
  authUserSchema,
  signInResultSchema,
} from "../../lib/shared/auth-contract";
import AUTH_ERROR_CODES from "../../lib/shared/auth-error-codes.constants";
import {
  LOADING_STATE,
  SIGNED_OUT_STATE,
} from "../../lib/shared/auth-states.constants";
import AUTH_STATUSES from "../../lib/shared/auth-statuses.constants";
import createAuthError from "../../lib/shared/create-auth-error.helper";
import { isAuthState, isSignInResult } from "../../lib/shared/is-auth-state";

const USER = { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" };
const ERROR = createAuthError("RATE_LIMITED", 120);

describe("authContract", () => {
  test("should be accepted by defineContract on its own and inside an app's contract", () => {
    expect(() => defineContract(authContract)).not.toThrow();
    const app = defineContract({
      invoke: {
        ...authContract.invoke,
        "notes:list": { output: z.array(z.string()) },
      },
      events: { ...authContract.events, "notes:changed": z.string() },
    });
    expect(Object.keys(app.invoke)).toEqual([
      "auth:get-state",
      "auth:sign-in",
      "auth:cancel-sign-in",
      "auth:sign-out",
      "notes:list",
    ]);
  });

  test("sentinel: the preload's channel map should name exactly the contract's channels", () => {
    expect(AUTH_CHANNELS).toEqual(channelsOf(authContract));
  });

  test("should keep the state and the sign-in outcome as the only payloads", () => {
    expect(authContract.invoke["auth:get-state"].output).toBe(authStateSchema);
    expect(authContract.invoke["auth:sign-in"].output).toBe(signInResultSchema);
    expect(authContract.events["auth:changed"]).toBe(authStateSchema);
    expect(authContract.invoke["auth:cancel-sign-in"]).toEqual({});
    expect(authContract.invoke["auth:sign-out"]).toEqual({});
  });

  test("should have no field for a token in anything that crosses to the renderer", () => {
    const leaked = {
      status: "signed-in",
      user: { ...USER, refreshToken: "r", accessToken: "a" },
      error: null,
      isRemembered: true,
      refreshToken: "r",
    };
    expect(authStateSchema.parse(leaked)).toEqual({
      status: "signed-in",
      user: USER,
      error: null,
      isRemembered: true,
    });
  });

  test("should accept every status and every error code", () => {
    for (const status of AUTH_STATUSES) {
      expect(
        authStateSchema.safeParse({ ...SIGNED_OUT_STATE, status }).success
      ).toBe(true);
    }
    for (const code of AUTH_ERROR_CODES) {
      expect(authErrorSchema.safeParse(createAuthError(code)).success).toBe(
        true
      );
    }
    expect(authUserSchema.safeParse(USER).success).toBe(true);
  });
});

// The renderer checks what arrives without Zod. Both sides must agree on every value.
describe("the renderer's guards against the contract's schemas", () => {
  const states: unknown[] = [
    LOADING_STATE,
    SIGNED_OUT_STATE,
    { status: "signing-in", user: null, error: null, isRemembered: false },
    { status: "signed-in", user: USER, error: null, isRemembered: true },
    { status: "signed-out", user: null, error: ERROR, isRemembered: false },
    {
      status: "signed-out",
      user: null,
      error: createAuthError("OFFLINE"),
      isRemembered: false,
    },
    // Wrong ones.
    null,
    undefined,
    "signed-in",
    42,
    [],
    {},
    { status: "signed-up", user: null, error: null, isRemembered: false },
    { status: "signed-in", user: USER, error: null },
    { status: "signed-in", user: USER, error: null, isRemembered: "yes" },
    { status: "signed-in", user: undefined, error: null, isRemembered: true },
    { status: "signed-in", user: "ayse", error: null, isRemembered: true },
    {
      status: "signed-in",
      user: { ...USER, id: "41" },
      error: null,
      isRemembered: true,
    },
    {
      status: "signed-in",
      user: { ...USER, id: 4.5 },
      error: null,
      isRemembered: true,
    },
    {
      status: "signed-in",
      user: { id: 41, email: "a@b.c" },
      error: null,
      isRemembered: true,
    },
    {
      status: "signed-in",
      user: { id: 41, name: "Ayşe" },
      error: null,
      isRemembered: true,
    },
    { status: "signed-out", user: null, error: "x", isRemembered: false },
    { status: "signed-out", user: null, isRemembered: false },
    {
      status: "signed-out",
      user: null,
      error: { code: "NOPE", message: "x" },
      isRemembered: false,
    },
    {
      status: "signed-out",
      user: null,
      error: { code: "OFFLINE" },
      isRemembered: false,
    },
    {
      status: "signed-out",
      user: null,
      error: { ...ERROR, retryAfterSeconds: -1 },
      isRemembered: false,
    },
    {
      status: "signed-out",
      user: null,
      error: { ...ERROR, retryAfterSeconds: 1.5 },
      isRemembered: false,
    },
    {
      status: "signed-out",
      user: null,
      error: { ...ERROR, retryAfterSeconds: "120" },
      isRemembered: false,
    },
  ];

  test.each(states.map((value, index) => [index, value]))(
    "should judge state %d the way the schema does",
    (_index, value) => {
      expect(isAuthState(value)).toBe(authStateSchema.safeParse(value).success);
    }
  );

  const results: unknown[] = [
    { ok: true, user: USER },
    { ok: false, error: ERROR },
    { ok: false, error: createAuthError("SIGN_IN_CANCELLED") },
    // Wrong ones.
    null,
    undefined,
    true,
    {},
    { ok: true },
    { ok: true, user: null },
    { ok: true, error: ERROR },
    { ok: false },
    { ok: false, user: USER },
    { ok: false, error: null },
    { ok: "true", user: USER },
    { ok: 1, user: USER },
  ];

  test.each(results.map((value, index) => [index, value]))(
    "should judge sign-in outcome %d the way the schema does",
    (_index, value) => {
      expect(isSignInResult(value)).toBe(
        signInResultSchema.safeParse(value).success
      );
    }
  );

  test("should accept the good ones and refuse the wrong ones", () => {
    expect(states.filter(isAuthState)).toHaveLength(6);
    expect(results.filter(isSignInResult)).toHaveLength(3);
  });
});

describe("the fixed states", () => {
  test("should be frozen: they are shared by every caller", () => {
    expect(Object.isFrozen(LOADING_STATE)).toBe(true);
    expect(Object.isFrozen(SIGNED_OUT_STATE)).toBe(true);
    expect(LOADING_STATE.status).toBe("loading");
    expect(SIGNED_OUT_STATE.status).toBe("signed-out");
  });
});
