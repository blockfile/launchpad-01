/**
 * Sanitizers for attacker-controlled URLs. A token's `logo` and `socials.*` are
 * set by whoever called `launchToken` — anyone at all — and are rendered raw as
 * `<img src>` / `<a href>`. A `javascript:` href is click-gated XSS in the app
 * origin; `data:`/other schemes enable phishing, tracking, or content injection.
 * So EVERY such value is funnelled through one of these two allow-lists before
 * it reaches the DOM.
 */

/** IPFS gateway the app resolves `ipfs://` URIs through. A fixed host we
 * control the choice of — never derived from the attacker-supplied value. */
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/** Neutral inline placeholder shown when a logo URL is rejected. A constant
 * `data:` SVG (OUR value, not attacker input) so no network request and no
 * broken-image chrome leak from a hostile URL. */
export const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20width%3D'40'%20height%3D'40'%3E%3Crect%20width%3D'40'%20height%3D'40'%20fill%3D'%23334155'%2F%3E%3C%2Fsvg%3E";

/** `ipfs://CID`, `ipfs://CID/path`, or a stray `ipfs://ipfs/CID` → gateway URL.
 * Returns null for anything that isn't an `ipfs://` URI. */
function ipfsToGateway(url: string): string | null {
  const match = /^ipfs:\/\/(.+)$/i.exec(url);
  if (!match) return null;
  // Strip a redundant leading `ipfs/` some pinners emit, then encode the path.
  const path = match[1].replace(/^ipfs\//i, "");
  return IPFS_GATEWAY + path;
}

/** True only for an absolute `https:` URL. Uses the URL parser (not a regex) so
 * scheme-confusion tricks (`https:evil`, whitespace, casing) can't slip past. */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * An `<img src>`-safe value: `https:` passes through verbatim, `ipfs://` is
 * resolved to the gateway, and EVERYTHING else (`javascript:`, `data:`,
 * `http:`, relative, blank, malformed) collapses to {@link PLACEHOLDER_IMAGE}.
 */
export function safeImageSrc(url: string | null | undefined): string {
  if (!url) return PLACEHOLDER_IMAGE;
  const trimmed = url.trim();
  const gateway = ipfsToGateway(trimmed);
  if (gateway) return gateway;
  if (isHttps(trimmed)) return trimmed;
  return PLACEHOLDER_IMAGE;
}

/**
 * An `<a href>`-safe value: `https:` passes through verbatim, `ipfs://` is
 * resolved to the gateway, and EVERYTHING else returns null — the caller MUST
 * then render NO anchor (plain text/disabled span) rather than a live link.
 */
export function safeLinkHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const gateway = ipfsToGateway(trimmed);
  if (gateway) return gateway;
  if (isHttps(trimmed)) return trimmed;
  return null;
}
