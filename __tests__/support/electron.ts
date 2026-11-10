import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

// The stand-in for the `electron` module in the node tests. Only the operating system's part is
// faked: the key store is a reversible cipher whose output never contains the plain text, the
// user-data folder is a real temporary folder, and `net.fetch` is the real `fetch`. Everything
// this package builds on (`createSecretStore` of @handijit/electron, the API client of
// @handijit/core) is the real thing.

type Decrypted = { result: string; shouldReEncrypt: boolean };

const CIPHER_PREFIX = "v1:";

const control = {
  /** The user-data folder of this test. */
  userData: "",
  /** Whether the operating system offers encryption. */
  isEncryptionAvailable: true,
  /** What `shell.openExternal` does with an address. */
  openExternal: (async () => undefined) as (url: string) => Promise<void>,
};

const electronMock = {
  app: {
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    getPath: vi.fn(() => control.userData),
    getVersion: vi.fn(() => "1.4.0"),
    focus: vi.fn(),
  },
  net: {
    fetch: vi.fn((url: string, init?: RequestInit) => fetch(url, init)),
  },
  shell: {
    openExternal: vi.fn((url: string) => control.openExternal(url)),
  },
  safeStorage: {
    getSelectedStorageBackend: vi.fn(() => "gnome_libsecret"),
    isAsyncEncryptionAvailable: vi.fn(() =>
      Promise.resolve(control.isEncryptionAvailable)
    ),
    encryptStringAsync: vi.fn((plain: string) =>
      Promise.resolve(
        Buffer.from(
          CIPHER_PREFIX +
            Buffer.from([...plain].reverse().join("")).toString("hex")
        )
      )
    ),
    decryptStringAsync: vi.fn((encrypted: Buffer): Promise<Decrypted> => {
      const text = encrypted.toString();
      if (!text.startsWith(CIPHER_PREFIX)) {
        return Promise.reject(new Error("The key store cannot decrypt this"));
      }
      const reversed = Buffer.from(
        text.slice(CIPHER_PREFIX.length),
        "hex"
      ).toString();
      return Promise.resolve({
        result: [...reversed].reverse().join(""),
        shouldReEncrypt: false,
      });
    }),
  },
};

/** A fresh machine: an empty user-data folder and a working key store. */
const resetElectron = (): void => {
  control.userData = mkdtempSync(join(tmpdir(), "handijit-auth-"));
  control.isEncryptionAvailable = true;
  control.openExternal = async () => undefined;
  // Electron adds this to `process`; the default User-Agent reads it.
  Object.defineProperty(process, "getSystemVersion", {
    configurable: true,
    value: () => "15.1.0",
  });
};

const cleanElectron = (): void => {
  rmSync(control.userData, { recursive: true, force: true });
};

export { cleanElectron, control, electronMock, resetElectron };
