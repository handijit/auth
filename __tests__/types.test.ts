import type { ApiClient } from "@handijit/core";
import { defineContract } from "@handijit/electron";
import type { AppContext, Handlers } from "@handijit/electron/main";
import type { Client } from "@handijit/electron/renderer";
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";

import type { AUTH_CHANNELS, AuthContract } from "../lib/index";
import { authContract } from "../lib/index";
import type {
  Auth,
  AuthClient,
  AuthHost,
  AuthLogger,
  AuthOptions,
} from "../lib/main";
import type { UseAuth } from "../lib/react";
import type { AuthStore } from "../lib/renderer";
import type {
  AuthError,
  AuthErrorCode,
  AuthState,
  AuthStatus,
  AuthUser,
  SignInResult,
  Unsubscribe,
} from "../lib/types";

// An app's contract as a program composes it: its own channels and this package's.
const appContract = defineContract({
  invoke: {
    ...authContract.invoke,
    "notes:list": { output: z.array(z.string()) },
  },
  events: {
    ...authContract.events,
    "notes:changed": z.string(),
  },
});
type AppContract = typeof appContract;

describe("the types of the session", () => {
  test("should name exactly the four statuses", () => {
    expectTypeOf<AuthStatus>().toEqualTypeOf<
      "loading" | "signed-out" | "signing-in" | "signed-in"
    >();
  });

  test("should name exactly the documented error codes", () => {
    expectTypeOf<AuthErrorCode>().toEqualTypeOf<
      | "SIGN_IN_TIMED_OUT"
      | "SIGN_IN_CANCELLED"
      | "STATE_MISMATCH"
      | "CODE_REFUSED"
      | "RATE_LIMITED"
      | "OFFLINE"
      | "SESSION_ENDED"
      | "NOT_A_CUSTOMER"
      | "BROWSER_NOT_OPENED"
      | "LISTENER_FAILED"
      | "UNEXPECTED"
    >();
  });

  test("should have no field a token could travel in", () => {
    expectTypeOf<keyof AuthState>().toEqualTypeOf<
      "status" | "user" | "error" | "isRemembered"
    >();
    expectTypeOf<keyof AuthUser>().toEqualTypeOf<"id" | "email" | "name">();
    expectTypeOf<keyof AuthError>().toEqualTypeOf<
      "code" | "message" | "retryAfterSeconds"
    >();
  });

  test("should make a sign-in result a union that `ok` tells apart", () => {
    const result = {} as SignInResult;
    if (result.ok) {
      expectTypeOf(result.user).toEqualTypeOf<AuthUser>();
    } else {
      expectTypeOf(result.error).toEqualTypeOf<AuthError>();
    }
  });
});

describe("the types of the contract", () => {
  test("should infer the same shapes from the schemas as the hand-written types", () => {
    type StateOutput = z.infer<
      AuthContract["invoke"]["auth:get-state"]["output"]
    >;
    type ResultOutput = z.infer<
      AuthContract["invoke"]["auth:sign-in"]["output"]
    >;
    type EventPayload = z.infer<AuthContract["events"]["auth:changed"]>;

    expectTypeOf<StateOutput>().toExtend<AuthState>();
    expectTypeOf<AuthState>().toExtend<StateOutput>();
    expectTypeOf<ResultOutput>().toExtend<SignInResult>();
    expectTypeOf<SignInResult>().toExtend<ResultOutput>();
    expectTypeOf<EventPayload>().toExtend<AuthState>();
  });

  test("should give the preload the same channel names as the contract", () => {
    expectTypeOf<keyof (typeof AUTH_CHANNELS)["invoke"]>().toEqualTypeOf<
      keyof AuthContract["invoke"]
    >();
    expectTypeOf<keyof (typeof AUTH_CHANNELS)["events"]>().toEqualTypeOf<
      keyof AuthContract["events"]
    >();
  });

  test("should type the handlers as the handlers of the contract, without an input", () => {
    expectTypeOf<Auth["handlers"]>().toEqualTypeOf<Handlers<AuthContract>>();
    expectTypeOf<
      Parameters<Auth["handlers"]["auth:sign-in"]>[0]
    >().toEqualTypeOf<undefined>();
  });

  test("should keep its channels in a contract an app composed", () => {
    expectTypeOf(appContract.invoke).toHaveProperty("auth:get-state");
    expectTypeOf(appContract.invoke).toHaveProperty("notes:list");
    expectTypeOf(appContract.events).toHaveProperty("auth:changed");
  });

  test("should fit into the handlers of an app that composed the fragment", () => {
    const auth = {} as Auth;
    expectTypeOf({
      ...auth.handlers,
      "notes:list": (): string[] => [],
    }).toExtend<Handlers<AppContract>>();
  });

  test("should type the page's client of a composed contract", () => {
    type Page = Client<AppContract>;
    // Never called: only what the calls would answer is of interest.
    const askState = (page: Page) => page.invoke("auth:get-state");
    const signIn = (page: Page) => page.invoke("auth:sign-in");
    expectTypeOf(askState).returns.resolves.toExtend<AuthState>();
    expectTypeOf(signIn).returns.resolves.toExtend<SignInResult>();
  });
});

describe("the types of the main entry", () => {
  test("should require only the product", () => {
    expectTypeOf<{ product: string }>().toExtend<AuthOptions>();
    expectTypeOf<object>().not.toExtend<AuthOptions>();
  });

  test("should leave the three session calls out of the client, and nothing else", () => {
    expectTypeOf<Exclude<keyof ApiClient, keyof AuthClient>>().toEqualTypeOf<
      "exchangeDesktopCode" | "refresh" | "logout"
    >();
    expectTypeOf<AuthClient>().toExtend<Pick<ApiClient, "request">>();
    expectTypeOf<ApiClient>().toExtend<AuthClient>();
  });

  test("should accept the app context of a composed contract as the host to attach to", () => {
    expectTypeOf<AppContext<AppContract>>().toExtend<AuthHost>();
    expectTypeOf<Auth["attach"]>().returns.toEqualTypeOf<Unsubscribe>();
  });

  test("should never reject and never hand out a token", () => {
    expectTypeOf<
      Auth["signIn"]
    >().returns.resolves.toEqualTypeOf<SignInResult>();
    expectTypeOf<Auth["restore"]>().returns.resolves.toEqualTypeOf<AuthState>();
    expectTypeOf<Auth["signOut"]>().returns.resolves.toBeVoid();
    expectTypeOf<Auth["getState"]>().returns.toEqualTypeOf<AuthState>();
    expectTypeOf<keyof Auth>().toEqualTypeOf<
      | "client"
      | "handlers"
      | "getState"
      | "onChange"
      | "restore"
      | "signIn"
      | "cancelSignIn"
      | "signOut"
      | "attach"
      | "dispose"
    >();
  });

  test("should take a logger with two levels", () => {
    expectTypeOf<keyof AuthLogger>().toEqualTypeOf<"info" | "warn">();
    expectTypeOf<Pick<Console, "info" | "warn">>().toExtend<AuthLogger>();
  });
});

describe("the types of the page", () => {
  test("should give the store a state, a subscription and three actions", () => {
    expectTypeOf<AuthStore["getState"]>().returns.toEqualTypeOf<AuthState>();
    expectTypeOf<AuthStore["subscribe"]>().returns.toEqualTypeOf<Unsubscribe>();
    expectTypeOf<
      AuthStore["signIn"]
    >().returns.resolves.toEqualTypeOf<SignInResult>();
  });

  test("should give the hook the state and the actions in one object", () => {
    expectTypeOf<UseAuth>().toExtend<AuthState>();
    expectTypeOf<UseAuth["signIn"]>().toEqualTypeOf<AuthStore["signIn"]>();
    expectTypeOf<UseAuth["cancelSignIn"]>().toEqualTypeOf<
      AuthStore["cancelSignIn"]
    >();
    expectTypeOf<UseAuth["signOut"]>().toEqualTypeOf<AuthStore["signOut"]>();
  });
});
