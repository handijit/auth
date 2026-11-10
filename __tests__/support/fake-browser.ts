import { request as httpRequest } from "node:http";

import type { FakeApi, FakeUser } from "./fake-api";

// A stand-in for the customer's browser and the consent page: it receives the address the
// program opens, checks it the way the consent page does, and on approval makes the real
// top-level GET to the loopback address, following the redirect like a browser.

type RawResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

type Visit = {
  /** The address the program opened. */
  readonly url: URL;
  /** The parameters the consent page reads. */
  readonly product: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly state: string;
  /** The customer approves: a code is issued and the browser returns to the program. */
  readonly approve: (user?: FakeUser) => Promise<{
    callback: RawResponse;
    page: RawResponse | null;
    code: string;
  }>;
};

type FakeBrowser = {
  /** Give this to `openBrowser` (or let the `shell.openExternal` mock call it). */
  readonly open: (url: string) => Promise<void>;
  /** Every address that was opened, in order. */
  readonly visits: Visit[];
  /** Resolves with the visit of the given index once it has happened. */
  readonly visit: (index?: number) => Promise<Visit>;
};

const CUSTOMER: FakeUser = {
  id: 41,
  email: "ayse@example.com",
  name: "Ayşe Yılmaz",
  role: "CUSTOMER",
};

/** One HTTP request without a client's conveniences: any method, any `Host`, no redirects. */
const rawRequest = (
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    request.on("error", reject);
    request.end();
  });

const createFakeBrowser = (
  api: FakeApi,
  panelBaseUrl = "https://www.handijit.com"
): FakeBrowser => {
  const visits: Visit[] = [];
  const waiters: (() => void)[] = [];

  const open = async (raw: string): Promise<void> => {
    const url = new URL(raw);
    if (
      `${url.origin}${url.pathname}` !== `${panelBaseUrl}/panel/masaustu-giris`
    ) {
      throw new Error(`The program opened an unexpected address: ${raw}`);
    }
    const read = (name: string): string => {
      const values = url.searchParams.getAll(name);
      if (values.length !== 1) {
        throw new Error(`The consent page needs exactly one ${name}`);
      }
      return values[0] as string;
    };
    const product = read("product");
    const codeChallenge = read("code_challenge");
    const redirectUri = read("redirect_uri");
    const state = read("state");
    // The consent page's own checks (ADR-0024).
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      throw new Error("code_challenge must be 43 base64url characters");
    }
    if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/callback$/.test(redirectUri)) {
      throw new Error("redirect_uri must be a loopback /callback address");
    }
    if (state.length > 200) throw new Error("state is too long");

    visits.push({
      url,
      product,
      codeChallenge,
      redirectUri,
      state,
      approve: async (user = CUSTOMER) => {
        const code = api.authorize({ user, codeChallenge, redirectUri });
        const callback = await rawRequest(
          `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
        );
        const location = callback.headers.location;
        const page =
          callback.status === 303 && typeof location === "string"
            ? await rawRequest(new URL(location, redirectUri).toString())
            : null;
        return { callback, page, code };
      },
    });
    for (const wake of waiters.splice(0)) wake();
  };

  const visit = async (index = 0): Promise<Visit> => {
    while (visits.length <= index) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    return visits[index] as Visit;
  };

  return { open, visits, visit };
};

export type { FakeBrowser, RawResponse, Visit };
export { CUSTOMER, rawRequest };
export default createFakeBrowser;
