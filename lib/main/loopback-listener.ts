import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { loopbackRedirectUri } from "@handijit/core/pkce";

import { DONE_PAGE, INVALID_PAGE, returnPageCsp } from "./return-page";

/** RFC 8252 section 7.3: the literal IPv4 loopback address, never `localhost` or `0.0.0.0`. */
const LOOPBACK_HOST = "127.0.0.1";
/** The only path that counts; `loopbackRedirectUri` of core writes the same one. */
const CALLBACK_PATH = "/callback";
/** Where a good callback is sent on to, so that the code leaves the address bar and the history. */
const DONE_PATH = "/tamamlandi";
/** The backend's own bound on a code. */
const MAX_CODE_LENGTH = 128;
/** How many requests may be refused before the attempt gives up. A real sign-in refuses none. */
const DEFAULT_MAX_REFUSED_REQUESTS = 20;
/** How long the listener stays up after a good callback, to serve the page it redirected to. */
const DEFAULT_LINGER_MS = 5_000;
/** A browser's request line and headers fit many times over; a flood of large ones does not. */
const MAX_HEADER_BYTES = 8_192;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 32;

/** How the wait on the loopback address ended, when it ended by a request. */
type LoopbackOutcome =
  | {
      /** The browser came back with the right `state`. */
      readonly kind: "code";
      /** The one-time code to exchange. */
      readonly code: string;
    }
  | {
      /** Too many requests were refused; the attempt is not safe to continue. */
      readonly kind: "refused";
    };

type LoopbackListenerOptions = {
  /** The `state` of this attempt; a callback counts only when it brings the same one. */
  readonly state: string;
  /** A fixed port (1024–65535). Default: 0, the operating system picks a free one. */
  readonly port?: number;
  /** How many requests may be refused before the outcome is `refused`. Default: 20. */
  readonly maxRefusedRequests?: number;
  /** How long to stay up after the good callback, in milliseconds. Default: 5000. */
  readonly lingerMs?: number;
};

type LoopbackListener = {
  /** The port the listener is bound to. */
  readonly port: number;
  /** `http://127.0.0.1:<port>/callback`, the address to hand to the consent page. */
  readonly redirectUri: string;
  /** Settles on the first good callback or on the refusal bound; pending until then. */
  readonly outcome: Promise<LoopbackOutcome>;
  /** Stops listening and drops every open connection. Safe to call more than once. */
  readonly close: () => Promise<void>;
  /** Resolves once the port is free again. */
  readonly closed: Promise<void>;
};

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

/**
 * Listens on `127.0.0.1` for the browser's return from the consent page.
 *
 * - Only `GET /callback` with this listener's own `Host` counts; everything else is refused
 *   (`404`, or `400` for a foreign host) without a body.
 * - A callback must bring exactly one `code` and exactly one `state` equal to ours, compared in
 *   constant time. A wrong one is answered `400` and does not end the attempt, so another
 *   program on the machine cannot cancel a sign-in by poking the port; the number of refused
 *   requests is bounded instead.
 * - The first good callback wins: it is answered `303` to a code-free address that serves a
 *   small Turkish page, and the listener closes once that page is served or the linger time has
 *   passed. The same callback again gets the same redirect and changes nothing.
 *
 * Rejects when the port cannot be bound.
 */
const startLoopbackListener = async (
  options: LoopbackListenerOptions
): Promise<LoopbackListener> => {
  const {
    state,
    port = 0,
    maxRefusedRequests = DEFAULT_MAX_REFUSED_REQUESTS,
    lingerMs = DEFAULT_LINGER_MS,
  } = options;
  // A fixed port outside the range of the contract is a programming error: fail before binding.
  if (port !== 0) loopbackRedirectUri(port);

  const expectedState = digest(state);
  const headers = {
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Security-Policy": returnPageCsp(),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };

  let phase: "waiting" | "accepted" | "over" = "waiting";
  let acceptedCode = "";
  let refusedCount = 0;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;
  let boundPort = 0;

  let settle!: (outcome: LoopbackOutcome) => void;
  const outcome = new Promise<LoopbackOutcome>((resolve) => {
    settle = resolve;
  });
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const respond = (
    response: ServerResponse,
    status: number,
    body = "",
    extra: Readonly<Record<string, string>> = {}
  ): void => {
    response.writeHead(status, {
      ...headers,
      ...(body !== "" && { "Content-Type": "text/html; charset=utf-8" }),
      "Content-Length": Buffer.byteLength(body),
      ...extra,
    });
    response.end(body);
  };

  const refuse = (
    response: ServerResponse,
    status: number,
    body?: string
  ): void => {
    respond(response, status, body);
    if (phase !== "waiting") return;
    refusedCount += 1;
    if (refusedCount >= maxRefusedRequests) {
      phase = "over";
      settle({ kind: "refused" });
    }
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    // A page on another origin that reaches this port through a name it controls (DNS
    // rebinding) sends that name here.
    if (request.headers.host !== `${LOOPBACK_HOST}:${boundPort}`) {
      refuse(response, 400);
      return;
    }
    const target = String(request.url);
    const queryAt = target.indexOf("?");
    const path = queryAt === -1 ? target : target.slice(0, queryAt);

    if (
      request.method === "GET" &&
      path === DONE_PATH &&
      phase === "accepted"
    ) {
      respond(response, 200, DONE_PAGE);
      // The page is the last thing this listener has to say: stop accepting; the linger timer
      // drops whatever is still open.
      server.close();
      return;
    }
    // Chrome asks for /favicon.ico on the same port; that and everything else is not a callback.
    if (request.method !== "GET" || path !== CALLBACK_PATH) {
      refuse(response, 404);
      return;
    }

    const parameters = new URLSearchParams(
      queryAt === -1 ? "" : target.slice(queryAt + 1)
    );
    const codes = parameters.getAll("code");
    const states = parameters.getAll("state");
    const code = String(codes[0]);
    const isValid =
      codes.length === 1 &&
      states.length === 1 &&
      code !== "" &&
      code.length <= MAX_CODE_LENGTH &&
      timingSafeEqual(digest(String(states[0])), expectedState) &&
      // After the first good callback only its own repetition is good.
      (phase === "waiting" || (phase === "accepted" && code === acceptedCode));
    if (!isValid) {
      refuse(response, 400, INVALID_PAGE);
      return;
    }

    if (phase === "waiting") {
      phase = "accepted";
      acceptedCode = code;
      lingerTimer = setTimeout(() => void close(), lingerMs);
      lingerTimer.unref();
      settle({ kind: "code", code });
    }
    respond(response, 303, "", { Location: DONE_PATH });
  };

  const server = createServer(
    {
      maxHeaderSize: MAX_HEADER_BYTES,
      headersTimeout: REQUEST_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
    handle
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.on("close", () => {
    clearTimeout(lingerTimer);
    markClosed();
  });

  const close = (): Promise<void> => {
    server.close();
    server.closeAllConnections();
    return closed;
  };

  await new Promise<void>((resolve, reject) => {
    // Stays attached: after the bind it swallows a late socket error instead of crashing main.
    server.on("error", reject);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, resolve);
  });
  boundPort = (server.address() as AddressInfo).port;

  return {
    port: boundPort,
    redirectUri: loopbackRedirectUri(boundPort),
    outcome,
    close,
    closed,
  };
};

export type { LoopbackListener, LoopbackListenerOptions, LoopbackOutcome };
export default startLoopbackListener;
