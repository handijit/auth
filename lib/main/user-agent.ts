const OS_NAMES: Readonly<Record<string, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

type UserAgentParts = {
  /** The program's slug: the product token. */
  readonly product: string;
  /** The program's version. */
  readonly version: string;
  /** `process.platform`. */
  readonly platform: string;
  /** The operating system's version, e.g. `15.1.0`. */
  readonly systemVersion: string;
  /** `process.arch`. */
  readonly arch: string;
};

// A header value must be printable ASCII (core refuses anything else); the parts come from the
// program's package.json and the operating system, so nothing is expected to be removed.
const printable = (value: string): string =>
  value.replace(/[^\x21-\x7E]+/g, "");

/**
 * The `User-Agent` the backend stores as the session's device name:
 * `notlar/1.4.0 (macOS 15.1.0; arm64)`.
 */
const buildUserAgent = (parts: UserAgentParts): string => {
  const os = OS_NAMES[parts.platform] ?? printable(parts.platform);
  return `${printable(parts.product)}/${printable(parts.version)} (${os} ${printable(parts.systemVersion)}; ${printable(parts.arch)})`;
};

export type { UserAgentParts };
export default buildUserAgent;
