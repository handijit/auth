import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, vi } from "vitest";

import createAuth from "../../lib/main/create-auth";
import type { Auth, AuthOptions } from "../../lib/main/create-auth";
import type { AuthState, SignInResult } from "../../lib/types";
import { cleanElectron, control, resetElectron } from "./electron";
import startFakeApi from "./fake-api";
import type { FakeApi, FakeUser } from "./fake-api";
import createFakeBrowser, { CUSTOMER } from "./fake-browser";
import type { FakeBrowser } from "./fake-browser";

// One machine per test: an empty user-data folder, a backend, a browser. The test file mocks
// `electron` with the stand-in of ./electron before it imports this.

type AuthHarness = {
  /** The backend of this test. */
  api: FakeApi;
  /** The browser of this test; `shell.openExternal` leads to it. */
  browser: FakeBrowser;
  /** The logger every session of this test writes to. */
  readonly logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  /** A session as a program creates it. Calling it again is a restart on the same machine. */
  readonly create: (options?: Partial<AuthOptions>) => Auth;
  /** Starts a sign-in, approves it in the browser and resolves with the outcome. */
  readonly signInAs: (auth: Auth, user?: FakeUser) => Promise<SignInResult>;
  /** Every state the session goes through from now on. */
  readonly record: (auth: Auth) => AuthState[];
  /** The file the session is stored in. */
  readonly secretFile: () => string;
  /** Whether a session is stored on the disk. */
  readonly hasStoredSession: () => boolean;
  /** The bytes of the stored session. */
  readonly storedBytes: () => string;
  /** Everything the logger received, as text. */
  readonly logged: () => string;
};

/** Waits for something another part of the system does (real I/O, not a timer). */
const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = performance.now() + 4_000;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`Still waiting for ${what}`);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

const useAuthHarness = (): AuthHarness => {
  const created: Auth[] = [];
  const logger = { info: vi.fn(), warn: vi.fn() };

  const harness: AuthHarness = {
    api: undefined as unknown as FakeApi,
    browser: undefined as unknown as FakeBrowser,
    logger,
    create: (options = {}) => {
      const auth = createAuth({
        product: "notlar",
        apiBaseUrl: harness.api.url,
        logger,
        ...options,
      });
      created.push(auth);
      return auth;
    },
    signInAs: async (auth, user = CUSTOMER) => {
      const index = harness.browser.visits.length;
      const pending = auth.signIn();
      const visit = await harness.browser.visit(index);
      await visit.approve(user);
      return pending;
    },
    record: (auth) => {
      const seen: AuthState[] = [];
      auth.onChange((state) => seen.push(state));
      return seen;
    },
    secretFile: () => join(control.userData, "secrets", "auth-session.bin"),
    hasStoredSession: () => existsSync(harness.secretFile()),
    storedBytes: () => readFileSync(harness.secretFile(), "latin1"),
    logged: () =>
      JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]),
  };

  beforeEach(async () => {
    resetElectron();
    logger.info.mockReset();
    logger.warn.mockReset();
    harness.api = await startFakeApi();
    harness.browser = createFakeBrowser(harness.api);
    control.openExternal = harness.browser.open;
  });

  afterEach(async () => {
    await Promise.all(created.splice(0).map((auth) => auth.dispose()));
    await harness.api.close();
    cleanElectron();
  });

  return harness;
};

export type { AuthHarness };
export { until };
export default useAuthHarness;
