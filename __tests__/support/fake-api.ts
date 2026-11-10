import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for Han Dijit's backend, faithful to the parts of its contract this package
// relies on (docs/lisans.md, "Masaüstü girişi"):
//
// - a one-time code lives 60 seconds, belongs to one challenge and one redirect address, and is
//   consumed by the first exchange that names it, whatever the outcome;
// - every refusal of an exchange is the same `400 DESKTOP_CODE_INVALID`, except an account that
//   cannot sign in after a proven code: `403 DESKTOP_ACCOUNT_NOT_ALLOWED`;
// - a malformed exchange (`400 VALIDATION_ERROR`) and a rate-limited one (`429` with
//   `Retry-After`) do not consume the code;
// - a refresh rotates the refresh token with no grace period: the old one answers
//   `401 INVALID_TOKEN` from then on;
// - a logout answers `204` for any token;
// - the `User-Agent` of the exchange and of every refresh is stored on the session.

const CODE_LIFETIME_MS = 60_000;

type FakeRole = "CUSTOMER" | "ADMIN" | "USER";

type FakeUser = {
  id: number;
  email: string;
  name: string;
  role: FakeRole;
};

type RecordedRequest = {
  method: string;
  path: string;
  userAgent: string | undefined;
  authorization: string | undefined;
  body: unknown;
};

type FakeSession = {
  userId: number;
  refreshToken: string;
  accessToken: string;
  userAgent: string | undefined;
  isRevoked: boolean;
};

type IssuedCode = {
  userId: number;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
};

type FakeApi = {
  /** The base address to give to the client. */
  readonly url: string;
  /** Every request that arrived, in order. */
  readonly requests: RecordedRequest[];
  /** Every session ever created, revoked ones included. */
  readonly sessions: FakeSession[];
  /** What the consent page does on approval: issues a one-time code for a challenge. */
  readonly authorize: (input: {
    user: FakeUser;
    codeChallenge: string;
    redirectUri: string;
  }) => string;
  /** Requests to a path, counted. */
  readonly countOf: (path: string) => number;
  /** Answers every exchange with `429` and this `Retry-After`; `null` lifts it. */
  readonly rateLimit: (retryAfterSeconds: number | null) => void;
  /** Drops every connection without an answer while `true`. */
  readonly setOffline: (isOffline: boolean) => void;
  /** Handles the next request to the path, then drops the connection instead of answering. */
  readonly loseNextAnswer: (path: string) => void;
  /** Holds the answers of a path back until the returned function is called. */
  readonly hold: (path: string) => () => void;
  /** Answers the next request to the path with this status and an HTML body. */
  readonly breakNext: (path: string, status: number) => void;
  /** Makes the exchange answer for any role: a backend that forgot its own rule. */
  readonly skipRoleCheck: () => void;
  /** Changes a user's role, as an administrator would. */
  readonly setRole: (userId: number, role: FakeRole) => void;
  /** Changes a user's name. */
  readonly rename: (userId: number, name: string) => void;
  /** Ends every session, as "sign out everywhere" in the panel does. */
  readonly revokeAll: () => void;
  /** How long the access tokens of new sessions live. */
  readonly setAccessTokenLifetime: (seconds: number) => void;
  /** Stops the server. */
  readonly close: () => Promise<void>;
};

const token = (): string => randomBytes(24).toString("base64url");

const challengeOf = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const startFakeApi = async (): Promise<FakeApi> => {
  const users = new Map<number, FakeUser>();
  const codes = new Map<string, IssuedCode>();
  const sessions: FakeSession[] = [];
  const requests: RecordedRequest[] = [];
  const lost = new Set<string>();
  const broken = new Map<string, number>();
  const held = new Map<string, Promise<void>>();
  let retryAfterSeconds: number | null = null;
  let isOffline = false;
  let accessTokenLifetime = 900;
  let isRoleChecked = true;

  const json = (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): void => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(body));
  };

  const problem = (
    response: ServerResponse,
    status: number,
    code: string,
    detail: string,
    headers: Record<string, string> = {}
  ): void => {
    response.writeHead(status, {
      "Content-Type": "application/problem+json",
      ...headers,
    });
    response.end(
      JSON.stringify({
        type: "about:blank",
        title: code,
        status,
        detail,
        code,
      })
    );
  };

  const userView = (user: FakeUser): Record<string, unknown> => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleLabel: user.role === "CUSTOMER" ? "Müşteri" : "Yönetici",
    createdAt: "2026-01-05T09:00:00Z",
  });

  const openSession = (
    user: FakeUser,
    userAgent: string | undefined
  ): Record<string, unknown> => {
    const session: FakeSession = {
      userId: user.id,
      refreshToken: token(),
      accessToken: token(),
      userAgent,
      isRevoked: false,
    };
    sessions.push(session);
    return {
      accessToken: session.accessToken,
      expiresInSeconds: accessTokenLifetime,
      refreshToken: session.refreshToken,
      user: userView(user),
    };
  };

  const exchange = (
    response: ServerResponse,
    body: unknown,
    userAgent: string | undefined
  ): void => {
    if (retryAfterSeconds !== null) {
      problem(response, 429, "TOO_MANY_REQUESTS", "Çok fazla deneme.", {
        "Retry-After": String(retryAfterSeconds),
      });
      return;
    }
    if (
      !isRecord(body) ||
      typeof body.code !== "string" ||
      typeof body.codeVerifier !== "string" ||
      typeof body.redirectUri !== "string"
    ) {
      problem(response, 400, "VALIDATION_ERROR", "Eksik alan.");
      return;
    }
    const issued = codes.get(body.code);
    // Consumed by the first attempt that names it, whatever happens next.
    codes.delete(body.code);
    const user = issued === undefined ? undefined : users.get(issued.userId);
    if (
      issued === undefined ||
      user === undefined ||
      Date.now() >= issued.expiresAt ||
      challengeOf(body.codeVerifier) !== issued.codeChallenge ||
      body.redirectUri !== issued.redirectUri
    ) {
      problem(response, 400, "DESKTOP_CODE_INVALID", "Giriş kodu geçersiz.");
      return;
    }
    // A request that proved the code and its verifier learns why the account cannot sign in.
    if (isRoleChecked && user.role !== "CUSTOMER") {
      problem(
        response,
        403,
        "DESKTOP_ACCOUNT_NOT_ALLOWED",
        "Bu hesap programda oturum açamaz."
      );
      return;
    }
    json(response, 200, openSession(user, userAgent));
  };

  const refresh = (
    response: ServerResponse,
    body: unknown,
    userAgent: string | undefined
  ): void => {
    const presented = isRecord(body) ? body.refreshToken : undefined;
    const session = sessions.find(
      (candidate) =>
        candidate.refreshToken === presented && !candidate.isRevoked
    );
    const user = session === undefined ? undefined : users.get(session.userId);
    if (session === undefined || user === undefined) {
      problem(response, 401, "INVALID_TOKEN", "Oturum geçersiz.");
      return;
    }
    // Rotation without a grace period: the presented token is dead from here on.
    session.isRevoked = true;
    json(response, 200, openSession(user, userAgent));
  };

  const logout = (response: ServerResponse, body: unknown): void => {
    const presented = isRecord(body) ? body.refreshToken : undefined;
    for (const session of sessions) {
      if (session.refreshToken === presented) session.isRevoked = true;
    }
    response.writeHead(204).end();
  };

  const me = (
    response: ServerResponse,
    authorization: string | undefined
  ): void => {
    const session = sessions.find(
      (candidate) =>
        !candidate.isRevoked &&
        authorization === `Bearer ${candidate.accessToken}`
    );
    const user = session === undefined ? undefined : users.get(session.userId);
    if (user === undefined) {
      // The backend refuses a missing or dead access token with an empty 401.
      response.writeHead(401).end();
      return;
    }
    json(response, 200, userView(user));
  };

  const server = createServer((request, response) => {
    void (async () => {
      const path = String(request.url).split("?")[0] as string;
      const method = String(request.method);
      const userAgent = request.headers["user-agent"];
      const authorization = request.headers.authorization;
      const body = await readBody(request);
      requests.push({ method, path, userAgent, authorization, body });

      if (isOffline) {
        request.socket.destroy();
        return;
      }
      await held.get(path);
      const brokenStatus = broken.get(path);
      if (brokenStatus !== undefined) {
        broken.delete(path);
        response.writeHead(brokenStatus, { "Content-Type": "text/html" });
        response.end("<html>bad gateway</html>");
        return;
      }

      const answer: ServerResponse = lost.delete(path)
        ? // Everything happens, but the answer never leaves.
          ({
            writeHead: () => answer,
            end: () => {
              request.socket.destroy();
              return answer;
            },
          } as unknown as ServerResponse)
        : response;

      if (method === "POST" && path === "/api/public/desktop/token") {
        exchange(answer, body, userAgent);
      } else if (method === "POST" && path === "/api/auth/refresh") {
        refresh(answer, body, userAgent);
      } else if (method === "POST" && path === "/api/auth/logout") {
        logout(answer, body);
      } else if (method === "GET" && path === "/api/auth/me") {
        me(answer, authorization);
      } else {
        problem(answer, 404, "NOT_FOUND", "Bulunamadı.");
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    sessions,
    authorize: ({ user, codeChallenge, redirectUri }) => {
      users.set(user.id, { ...user });
      const code = randomBytes(32).toString("base64url");
      codes.set(code, {
        userId: user.id,
        codeChallenge,
        redirectUri,
        expiresAt: Date.now() + CODE_LIFETIME_MS,
      });
      return code;
    },
    countOf: (path) =>
      requests.filter((request) => request.path === path).length,
    rateLimit: (seconds) => {
      retryAfterSeconds = seconds;
    },
    setOffline: (value) => {
      isOffline = value;
    },
    loseNextAnswer: (path) => {
      lost.add(path);
    },
    hold: (path) => {
      let release!: () => void;
      held.set(
        path,
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      return () => {
        held.delete(path);
        release();
      };
    },
    breakNext: (path, status) => {
      broken.set(path, status);
    },
    skipRoleCheck: () => {
      isRoleChecked = false;
    },
    setRole: (userId, role) => {
      const user = users.get(userId);
      if (user !== undefined) user.role = role;
    },
    rename: (userId, name) => {
      const user = users.get(userId);
      if (user !== undefined) user.name = name;
    },
    revokeAll: () => {
      for (const session of sessions) session.isRevoked = true;
    },
    setAccessTokenLifetime: (seconds) => {
      accessTokenLifetime = seconds;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

export type { FakeApi, FakeRole, FakeSession, FakeUser, RecordedRequest };
export default startFakeApi;
