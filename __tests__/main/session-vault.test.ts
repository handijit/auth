import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSecretStore } from "@handijit/electron/main";
import type { SecretStore } from "@handijit/electron/main";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import createSessionVault, {
  SESSION_SECRET_NAME,
} from "../../lib/main/session-vault";
import { cleanElectron, control, resetElectron } from "../support/electron";

vi.mock("electron", async () => {
  const { electronMock } = await import("../support/electron");
  return electronMock;
});

const SESSION = {
  refreshToken: "refresh-token-1",
  user: { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" },
};

const logger = { info: vi.fn(), warn: vi.fn() };

const secretFile = (): string =>
  join(control.userData, "secrets", `${SESSION_SECRET_NAME}.bin`);

const filesOnDisk = (): string[] => {
  try {
    return readdirSync(join(control.userData, "secrets"));
  } catch {
    return [];
  }
};

beforeEach(() => {
  resetElectron();
  logger.info.mockReset();
  logger.warn.mockReset();
});

afterEach(() => {
  cleanElectron();
});

describe("createSessionVault over the real secret store", () => {
  test("should answer null when nothing was stored", async () => {
    const vault = createSessionVault({
      secretStore: createSecretStore(),
      logger,
    });
    expect(await vault.load()).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("should give back what was saved, to a later process too", async () => {
    const first = createSessionVault({
      secretStore: createSecretStore(),
      logger,
    });
    expect(await first.save(SESSION)).toBe(true);

    const second = createSessionVault({
      secretStore: createSecretStore(),
      logger,
    });
    expect(await second.load()).toEqual(SESSION);
  });

  test("should write neither the token nor the e-mail address in plain text", async () => {
    const vault = createSessionVault({
      secretStore: createSecretStore(),
      logger,
    });
    await vault.save(SESSION);
    expect(filesOnDisk()).toEqual([`${SESSION_SECRET_NAME}.bin`]);
    const bytes = readFileSync(secretFile(), "latin1");
    expect(bytes).not.toContain(SESSION.refreshToken);
    expect(bytes).not.toContain(SESSION.user.email);
  });

  test("should forget the session on clear", async () => {
    const vault = createSessionVault({
      secretStore: createSecretStore(),
      logger,
    });
    await vault.save(SESSION);
    await vault.clear();
    expect(await vault.load()).toBeNull();
    expect(filesOnDisk()).toEqual([]);
    // Clearing nothing is not a problem either.
    await vault.clear();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("should run its calls in the order they were made", async () => {
    const vault = createSessionVault({
      secretStore: createSecretStore(),
      logger,
    });
    const saved = vault.save(SESSION);
    const cleared = vault.clear();
    const loaded = vault.load();
    expect(await saved).toBe(true);
    await cleared;
    expect(await loaded).toBeNull();
  });

  test("should store nothing, and say so, when the system offers no encryption", async () => {
    control.isEncryptionAvailable = false;
    const vault = createSessionVault({
      secretStore: createSecretStore(),
      logger,
    });
    expect(await vault.save(SESSION)).toBe(false);
    expect(filesOnDisk()).toEqual([]);
    expect(await vault.load()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "The session could not be stored; it lasts until the program closes",
      { reason: expect.any(String) }
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      SESSION.refreshToken
    );
  });

  test("should remove an older session when the new one cannot be stored", async () => {
    const vault = createSessionVault({
      secretStore: createSecretStore(),
      logger,
    });
    await vault.save(SESSION);
    control.isEncryptionAvailable = false;
    expect(
      await vault.save({ ...SESSION, refreshToken: "refresh-token-2" })
    ).toBe(false);
    expect(filesOnDisk()).toEqual([]);
  });

  test.each([
    ["text that is not JSON", "not json"],
    ["another version", JSON.stringify({ ...SESSION, v: 2 })],
    ["no token", JSON.stringify({ v: 1, user: SESSION.user })],
    ["an empty token", JSON.stringify({ ...SESSION, v: 1, refreshToken: "" })],
    [
      "a user without an id",
      JSON.stringify({
        v: 1,
        refreshToken: "r",
        user: { email: "a", name: "b" },
      }),
    ],
    ["null", "null"],
  ])("should remove a stored value that is %s", async (_name, value) => {
    const secretStore = createSecretStore();
    await secretStore.set(SESSION_SECRET_NAME, value);
    const vault = createSessionVault({ secretStore, logger });
    expect(await vault.load()).toBeNull();
    expect(filesOnDisk()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "The stored session is not valid and was removed"
    );
  });

  test("should answer null for a file the key store cannot decrypt", async () => {
    const secretStore = createSecretStore();
    await secretStore.set(SESSION_SECRET_NAME, JSON.stringify(SESSION));
    writeFileSync(secretFile(), "garbage");
    const vault = createSessionVault({ secretStore, logger });
    expect(await vault.load()).toBeNull();
  });

  test("should drop unknown keys of a stored session", async () => {
    const secretStore = createSecretStore();
    await secretStore.set(
      SESSION_SECRET_NAME,
      JSON.stringify({
        v: 1,
        ...SESSION,
        accessToken: "never stored",
        user: { ...SESSION.user, role: "CUSTOMER" },
      })
    );
    const vault = createSessionVault({ secretStore, logger });
    expect(await vault.load()).toEqual(SESSION);
  });
});

describe("createSessionVault over a store that fails", () => {
  const failing = (overrides: Partial<SecretStore>): SecretStore => ({
    isAvailable: () => Promise.resolve(true),
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    ...overrides,
  });

  test("should answer null when the read fails", async () => {
    const vault = createSessionVault({
      secretStore: failing({
        get: () => Promise.reject(new Error("EIO: read failed")),
      }),
      logger,
    });
    expect(await vault.load()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "The stored session could not be read",
      { reason: "EIO: read failed" }
    );
  });

  test("should not reject when the removal fails, and keep working afterwards", async () => {
    const vault = createSessionVault({
      secretStore: failing({
        // A store that rejects with something that is not an Error.
        delete: () => Promise.reject("EPERM"),
      }),
      logger,
    });
    await expect(vault.clear()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "The stored session could not be removed",
      { reason: "EPERM" }
    );
    expect(await vault.save(SESSION)).toBe(true);
  });

  test("should answer false when the write fails with something that is not an Error", async () => {
    const vault = createSessionVault({
      secretStore: failing({
        set: () => Promise.reject("ENOSPC"),
      }),
      logger,
    });
    expect(await vault.save(SESSION)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "The session could not be stored; it lasts until the program closes",
      { reason: "ENOSPC" }
    );
  });

  test("should report a read that fails with something that is not an Error", async () => {
    const vault = createSessionVault({
      secretStore: failing({
        get: () => Promise.reject("EIO"),
      }),
      logger,
    });
    expect(await vault.load()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "The stored session could not be read",
      { reason: "EIO" }
    );
  });
});
