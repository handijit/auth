import { createServer, connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { networkInterfaces } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";

import startLoopbackListener from "../../lib/main/loopback-listener";
import type {
  LoopbackListener,
  LoopbackListenerOptions,
  LoopbackOutcome,
} from "../../lib/main/loopback-listener";
import {
  DONE_PAGE,
  INVALID_PAGE,
  returnPageCsp,
} from "../../lib/main/return-page";
import { rawRequest } from "../support/fake-browser";
import type { RawResponse } from "../support/fake-browser";

// Every request below is a real HTTP request to a real listener on 127.0.0.1.

const STATE = "q3hJ2mXv8sT1bN6yKc0PzL4wRf7AdUeG9iOoVtYxZ5k";
const CODE = "c2VjcmV0LWNvZGUtZm9yLXRoZS1wcm9ncmFtLTEyMzQ1Njc4OTA";

const started: LoopbackListener[] = [];

const start = async (
  options: Partial<LoopbackListenerOptions> = {}
): Promise<LoopbackListener> => {
  const listener = await startLoopbackListener({ state: STATE, ...options });
  started.push(listener);
  return listener;
};

const callbackUrl = (
  listener: LoopbackListener,
  query = `code=${CODE}&state=${STATE}`
): string => `${listener.redirectUri}?${query}`;

const isSettled = async (promise: Promise<unknown>): Promise<boolean> => {
  const pending = Symbol("pending");
  return (await Promise.race([promise, Promise.resolve(pending)])) !== pending;
};

/** Sends raw bytes and resolves with everything the listener answered before it hung up. */
const rawBytes = (port: number, bytes: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(bytes);
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });

/** Whether a TCP connection to the address is accepted within a second. */
const canConnect = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (isOpen: boolean): void => {
      socket.destroy();
      resolve(isOpen);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });

const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
};

const expectSafeHeaders = (response: RawResponse): void => {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["content-security-policy"]).toBe(returnPageCsp());
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers.connection).toBe("close");
};

afterEach(async () => {
  await Promise.all(started.splice(0).map((listener) => listener.close()));
});

describe("startLoopbackListener: the address", () => {
  test("should listen on a port the system picked, within the contract's range", async () => {
    const listener = await start();
    expect(listener.port).toBeGreaterThanOrEqual(1024);
    expect(listener.port).toBeLessThanOrEqual(65535);
    expect(listener.redirectUri).toBe(
      `http://127.0.0.1:${listener.port}/callback`
    );
  });

  test("should give two attempts two different ports", async () => {
    const [first, second] = await Promise.all([start(), start()]);
    expect(first.port).not.toBe(second.port);
  });

  test("should listen on the fixed port it was given", async () => {
    const port = await freePort();
    const listener = await start({ port });
    expect(listener.port).toBe(port);
  });

  test("should reject when the port is in use", async () => {
    const first = await start();
    await expect(start({ port: first.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    // The first listener is unharmed.
    const response = await rawRequest(callbackUrl(first));
    expect(response.status).toBe(303);
  });

  test.each([80, 1023, 65536, 1.5, -1])(
    "should refuse the fixed port %d before binding anything",
    async (port) => {
      await expect(start({ port })).rejects.toThrow(RangeError);
    }
  );

  test("should not be reachable through another address of the machine", async () => {
    const listener = await start();
    const others = [
      "::1",
      ...Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .filter((address) => address.family === "IPv4" && !address.internal)
        .map((address) => address.address),
    ];
    for (const host of others) {
      expect(await canConnect(host, listener.port), host).toBe(false);
    }
    expect(await canConnect("127.0.0.1", listener.port)).toBe(true);
  });
});

describe("startLoopbackListener: the callback", () => {
  test("should take the code of a GET /callback with its own state", async () => {
    const listener = await start();
    const response = await rawRequest(callbackUrl(listener));

    expect(await listener.outcome).toEqual({ kind: "code", code: CODE });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/tamamlandi");
    expect(response.body).toBe("");
    expectSafeHeaders(response);
  });

  test("should serve the Turkish page at the code-free address, then stop listening", async () => {
    const listener = await start();
    await rawRequest(callbackUrl(listener));
    const page = await rawRequest(
      `http://127.0.0.1:${listener.port}/tamamlandi`
    );

    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-length"]).toBe(
      String(Buffer.byteLength(DONE_PAGE))
    );
    expect(page.body).toBe(DONE_PAGE);
    expectSafeHeaders(page);

    await listener.closed;
    await expect(rawRequest(callbackUrl(listener))).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });

  test("should not serve the page before a callback was accepted", async () => {
    const listener = await start();
    const page = await rawRequest(
      `http://127.0.0.1:${listener.port}/tamamlandi`
    );
    expect(page.status).toBe(404);
    expect(page.body).toBe("");
  });

  test("should accept a code of the backend's longest length and refuse a longer one", async () => {
    const longest = await start();
    const code = "a".repeat(128);
    await rawRequest(callbackUrl(longest, `code=${code}&state=${STATE}`));
    expect(await longest.outcome).toEqual({ kind: "code", code });

    const tooLong = await start();
    const response = await rawRequest(
      callbackUrl(tooLong, `code=${"a".repeat(129)}&state=${STATE}`)
    );
    expect(response.status).toBe(400);
    expect(await isSettled(tooLong.outcome)).toBe(false);
  });

  test("should decode the query the way a browser encoded it", async () => {
    const state = "a b&c=d/é";
    const listener = await start({ state });
    await rawRequest(
      callbackUrl(listener, `state=${encodeURIComponent(state)}&code=x%2By`)
    );
    expect(await listener.outcome).toEqual({ kind: "code", code: "x+y" });
  });

  test.each([
    ["a wrong state", `code=${CODE}&state=${STATE.slice(0, -1)}x`],
    ["a state of another length", `code=${CODE}&state=short`],
    ["an empty state", `code=${CODE}&state=`],
    ["no state", `code=${CODE}`],
    ["two states", `code=${CODE}&state=${STATE}&state=${STATE}`],
    ["two codes", `code=${CODE}&code=${CODE}&state=${STATE}`],
    ["an empty code", `code=&state=${STATE}`],
    ["no code", `state=${STATE}`],
    ["an error instead of a code", `error=access_denied&state=${STATE}`],
    ["a broken escape", `code=${CODE}&state=%E0%A4%A`],
    ["no query", ""],
  ])(
    "should refuse a callback with %s and keep waiting",
    async (_name, query) => {
      const listener = await start();
      const response = await rawRequest(
        query === "" ? listener.redirectUri : callbackUrl(listener, query)
      );

      expect(response.status).toBe(400);
      expect(response.body).toBe(INVALID_PAGE);
      expectSafeHeaders(response);
      expect(await isSettled(listener.outcome)).toBe(false);

      // The real browser can still come back.
      await rawRequest(callbackUrl(listener));
      expect(await listener.outcome).toEqual({ kind: "code", code: CODE });
    }
  );

  test("should never write anything from the request into a page", async () => {
    const listener = await start();
    const marker = "%3Cscript%3Ealert(1)%3C%2Fscript%3E";
    const response = await rawRequest(
      callbackUrl(listener, `code=${marker}&state=${marker}&x=${marker}`)
    );
    expect(response.body).toBe(INVALID_PAGE);
    expect(response.body).not.toContain("alert");
  });
});

describe("startLoopbackListener: everything that is not the callback", () => {
  test("should answer the favicon request of a real browser with 404 and keep waiting", async () => {
    const listener = await start();
    const favicon = await rawRequest(
      `http://127.0.0.1:${listener.port}/favicon.ico`
    );
    expect(favicon.status).toBe(404);
    expect(favicon.body).toBe("");
    expectSafeHeaders(favicon);
    expect(await isSettled(listener.outcome)).toBe(false);

    await rawRequest(callbackUrl(listener));
    expect(await listener.outcome).toEqual({ kind: "code", code: CODE });
  });

  test.each([
    "/",
    "/callback/",
    "/Callback",
    "/callback.html",
    "//callback",
    "/x/../callback",
    "/api/callback",
  ])(
    "should answer GET %s with 404 even with the right state",
    async (path) => {
      const listener = await start();
      const response = await rawBytes(
        listener.port,
        `GET ${path}?code=${CODE}&state=${STATE} HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\n\r\n`
      );
      expect(response).toMatch(/^HTTP\/1\.1 404 /);
      expect(await isSettled(listener.outcome)).toBe(false);
    }
  );

  test.each(["POST", "HEAD", "PUT", "DELETE", "OPTIONS"])(
    "should answer %s /callback with 404 even with the right state",
    async (method) => {
      const listener = await start();
      const response = await rawRequest(callbackUrl(listener), { method });
      expect(response.status).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(await isSettled(listener.outcome)).toBe(false);
    }
  );

  test.each([
    ["localhost:<port>", (port: number) => `localhost:${port}`],
    ["evil.example:<port>", (port: number) => `evil.example:${port}`],
    ["[::1]:<port>", (port: number) => `[::1]:${port}`],
    ["127.0.0.1 without the port", () => "127.0.0.1"],
    ["127.0.0.1 with another port", (port: number) => `127.0.0.1:${port + 1}`],
    [
      "127.0.0.1:<port> with a trailing dot",
      (port: number) => `127.0.0.1:${port}.`,
    ],
  ])(
    "should refuse the right callback sent under the host %s",
    async (_name, hostOf) => {
      const listener = await start();
      const response = await rawRequest(callbackUrl(listener), {
        headers: { Host: hostOf(listener.port) },
      });
      expect(response.status).toBe(400);
      expect(response.body).toBe("");
      expect(await isSettled(listener.outcome)).toBe(false);
    }
  );

  test("should refuse a request without a Host header", async () => {
    const listener = await start();
    const response = await rawBytes(
      listener.port,
      `GET /callback?code=${CODE}&state=${STATE} HTTP/1.0\r\n\r\n`
    );
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(await isSettled(listener.outcome)).toBe(false);
  });

  test("should refuse an absolute-form request line", async () => {
    const listener = await start();
    const response = await rawBytes(
      listener.port,
      `GET ${callbackUrl(listener)} HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\n\r\n`
    );
    expect(response).toMatch(/^HTTP\/1\.1 404 /);
    expect(await isSettled(listener.outcome)).toBe(false);
  });

  test("should survive headers larger than a browser sends, and bytes that are not HTTP", async () => {
    const listener = await start();
    const oversized = await rawBytes(
      listener.port,
      `GET /callback HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\nX-Fill: ${"x".repeat(20_000)}\r\n\r\n`
    );
    expect(oversized).toMatch(/^HTTP\/1\.1 431 /);
    const garbage = await rawBytes(
      listener.port,
      "\u0000\u0001 not http\r\n\r\n"
    );
    expect(garbage).toMatch(/^HTTP\/1\.1 400 /);

    await rawRequest(callbackUrl(listener));
    expect(await listener.outcome).toEqual({ kind: "code", code: CODE });
  });
});

describe("startLoopbackListener: a flood", () => {
  test("should give up after the bound of refused requests, whatever they were", async () => {
    const listener = await start({ maxRefusedRequests: 4 });
    const base = `http://127.0.0.1:${listener.port}`;

    await rawRequest(`${base}/favicon.ico`);
    await rawRequest(callbackUrl(listener, `code=${CODE}&state=wrong`));
    await rawRequest(callbackUrl(listener), {
      headers: { Host: "evil.example" },
    });
    expect(await isSettled(listener.outcome)).toBe(false);

    await rawRequest(callbackUrl(listener), { method: "POST" });
    expect(await listener.outcome).toEqual({ kind: "refused" });
  });

  test("should refuse even the right callback once it has given up", async () => {
    const listener = await start({ maxRefusedRequests: 1 });
    await rawRequest(callbackUrl(listener, `code=${CODE}&state=wrong`));
    const late = await rawRequest(callbackUrl(listener));

    expect(late.status).toBe(400);
    expect(await listener.outcome).toEqual({ kind: "refused" });
  });

  test("should accept the right callback one request before the bound", async () => {
    const listener = await start();
    const wrong = callbackUrl(listener, `code=${CODE}&state=wrong`);
    for (let index = 0; index < 19; index++) {
      expect((await rawRequest(wrong)).status).toBe(400);
    }
    await rawRequest(callbackUrl(listener));
    expect(await listener.outcome).toEqual({ kind: "code", code: CODE });
  });

  test("should give up at twenty refused requests by default", async () => {
    const listener = await start();
    const wrong = callbackUrl(listener, `code=${CODE}&state=wrong`);
    await Promise.all(Array.from({ length: 20 }, () => rawRequest(wrong)));
    expect(await listener.outcome).toEqual({ kind: "refused" });
  });
});

describe("startLoopbackListener: after the first good callback", () => {
  test("should answer the same callback again the same way and change nothing", async () => {
    const listener = await start();
    const outcomes: LoopbackOutcome[] = [];
    void listener.outcome.then((outcome) => outcomes.push(outcome));

    const first = await rawRequest(callbackUrl(listener));
    const second = await rawRequest(callbackUrl(listener));

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(second.headers.location).toBe("/tamamlandi");
    expect(outcomes).toEqual([{ kind: "code", code: CODE }]);
  });

  test("should refuse another code, even with the right state: the first one wins", async () => {
    const listener = await start();
    await rawRequest(callbackUrl(listener));
    const other = await rawRequest(
      callbackUrl(listener, `code=another-code&state=${STATE}`)
    );

    expect(other.status).toBe(400);
    expect(await listener.outcome).toEqual({ kind: "code", code: CODE });
  });

  test("should not count what it refuses any more", async () => {
    const listener = await start({ maxRefusedRequests: 1 });
    await rawRequest(callbackUrl(listener));
    const favicon = await rawRequest(
      `http://127.0.0.1:${listener.port}/favicon.ico`
    );

    expect(favicon.status).toBe(404);
    expect(await listener.outcome).toEqual({ kind: "code", code: CODE });
    // Still up for the page.
    const page = await rawRequest(
      `http://127.0.0.1:${listener.port}/tamamlandi`
    );
    expect(page.status).toBe(200);
  });

  test("should stop by itself after the linger time when the browser never asks for the page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listener = await start();
    await rawRequest(callbackUrl(listener));
    await listener.outcome;

    vi.advanceTimersByTime(4_999);
    expect(await isSettled(listener.closed)).toBe(false);
    expect((await rawRequest(callbackUrl(listener))).status).toBe(303);

    vi.advanceTimersByTime(1);
    await listener.closed;
    await expect(rawRequest(callbackUrl(listener))).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });

  test("should use the linger time it was given", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listener = await start({ lingerMs: 100 });
    await rawRequest(callbackUrl(listener));
    vi.advanceTimersByTime(100);
    await listener.closed;
  });
});

describe("startLoopbackListener: close", () => {
  test("should free the port, leave the outcome pending and be safe to repeat", async () => {
    const listener = await start();
    await listener.close();
    await listener.close();

    expect(await isSettled(listener.outcome)).toBe(false);
    await expect(rawRequest(callbackUrl(listener))).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    // The port can be bound again at once.
    const again = await start({ port: listener.port });
    expect(again.port).toBe(listener.port);
  });

  test("should drop a connection that is open and silent", async () => {
    const listener = await start();
    const socket = await new Promise<Socket>((resolve) => {
      const opened = connect({ host: "127.0.0.1", port: listener.port }, () =>
        resolve(opened)
      );
    });
    const hungUp = new Promise<void>((resolve) => {
      // Dropped means reset on some systems; either way the connection is over.
      socket.on("error", () => undefined);
      socket.on("close", () => resolve());
    });

    await listener.close();
    await hungUp;
    expect(socket.destroyed).toBe(true);
  });

  test("should leave no timer behind once the page was served", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listener = await start();
    await rawRequest(callbackUrl(listener));
    await rawRequest(`http://127.0.0.1:${listener.port}/tamamlandi`);
    await listener.closed;
    expect(vi.getTimerCount()).toBe(0);
  });

  test("should cancel the linger timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listener = await start();
    await rawRequest(callbackUrl(listener));
    expect(vi.getTimerCount()).toBe(1);
    await listener.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
