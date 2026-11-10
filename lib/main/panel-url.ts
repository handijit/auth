/** The consent page lives on the `www` host; the bare domain redirects and would drop nothing, but costs a hop. */
const DEFAULT_PANEL_BASE_URL = "https://www.handijit.com";
const SIGN_IN_PATH = "/panel/masaustu-giris";
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Checks `options.panelBaseUrl` and returns it without a trailing slash. The site must be
 * `https`; plain `http` is accepted for a loopback host only (a site running on the developer's
 * machine, a test). Throws a `TypeError` otherwise: the address is opened in the customer's
 * browser with a sign-in request in it.
 */
const readPanelBaseUrl = (value: string | undefined): string => {
  if (value === undefined) return DEFAULT_PANEL_BASE_URL;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // Not an absolute URL; reported below.
  }
  const isAllowed =
    url !== undefined &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        LOOPBACK_HOSTNAMES.includes(url.hostname))) &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "";
  if (!isAllowed) {
    throw new TypeError(
      `createAuth: options.panelBaseUrl must be an https URL (http for a loopback host) without credentials, query or fragment, received ${JSON.stringify(value)}`
    );
  }
  return value.replace(/\/+$/, "");
};

type SignInUrlParts = {
  /** The site's base address, as `readPanelBaseUrl` returned it. */
  readonly panelBaseUrl: string;
  /** The program's slug. */
  readonly product: string;
  /** The S256 challenge of the verifier. */
  readonly codeChallenge: string;
  /** The loopback address the browser returns to. */
  readonly redirectUri: string;
  /** The `state` of this attempt. */
  readonly state: string;
};

/** The address of the consent page for one attempt. The parameter names are the backend's contract. */
const buildSignInUrl = (parts: SignInUrlParts): string =>
  `${parts.panelBaseUrl}${SIGN_IN_PATH}?${new URLSearchParams({
    product: parts.product,
    code_challenge: parts.codeChallenge,
    redirect_uri: parts.redirectUri,
    state: parts.state,
  }).toString()}`;

export type { SignInUrlParts };
export { buildSignInUrl, readPanelBaseUrl };
