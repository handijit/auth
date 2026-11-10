import { describe, expect, test, vi } from "vitest";

import * as shared from "../lib/index";
import * as main from "../lib/main";
import * as preload from "../lib/preload";
import * as react from "../lib/react";
import * as renderer from "../lib/renderer";

// The barrels only re-export; `electron` is mocked so that importing them has no side effect.
vi.mock("electron", () => ({ app: {}, net: {}, safeStorage: {}, shell: {} }));

const names = (module: object): string[] => Object.keys(module).sort();

describe("the public API", () => {
  test("sentinel: the shared entry should export exactly its documented names", () => {
    expect(names(shared)).toEqual([
      "AUTH_CHANNELS",
      "AUTH_ERROR_CODES",
      "AUTH_STATUSES",
      "authContract",
      "authErrorMessage",
      "authErrorSchema",
      "authStateSchema",
      "authUserSchema",
      "signInResultSchema",
    ]);
  });

  test("sentinel: the main entry should export exactly its documented names", () => {
    expect(names(main)).toEqual(["createAuth"]);
  });

  test("sentinel: the preload entry should export exactly its documented names", () => {
    expect(names(preload)).toEqual(["AUTH_CHANNELS"]);
  });

  test("sentinel: the renderer entry should export exactly its documented names", () => {
    expect(names(renderer)).toEqual(["authErrorMessage", "getAuthStore"]);
  });

  test("sentinel: the React entry should export exactly its documented names", () => {
    expect(names(react)).toEqual(["useAuth"]);
  });

  test("should give the preload and the shared entry the same channel names", () => {
    expect(preload.AUTH_CHANNELS).toBe(shared.AUTH_CHANNELS);
  });

  test("should give the renderer and the shared entry the same sentences", () => {
    expect(renderer.authErrorMessage).toBe(shared.authErrorMessage);
  });

  test("should have a Turkish sentence for every error code", () => {
    for (const code of shared.AUTH_ERROR_CODES) {
      expect(shared.authErrorMessage(code)).toMatch(/\.$/);
    }
  });
});
