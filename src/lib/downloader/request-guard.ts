import { copy, parseLocale, type Locale } from "@/lib/i18n";

/** True when hostname is loopback (IPv4/IPv6/localhost). */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Desktop Studio mutating APIs: require JSON Content-Type for bodies, and when
 * Origin is present require same-origin or localhost. CLI never hits these routes.
 */
export function guardStudioMutation(
  request: Request,
  opts: { requireJsonBody?: boolean; lang?: unknown } = {},
): Response | null {
  const locale: Locale = parseLocale(opts.lang);
  const phrases = copy(locale);
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const reqUrl = new URL(request.url);
      const sameOrigin = originUrl.origin === reqUrl.origin;
      const localOk = isLoopbackHost(originUrl.hostname);
      if (!sameOrigin && !localOk) {
        return Response.json({ error: phrases.requestForbidden }, { status: 403 });
      }
    } catch {
      return Response.json({ error: phrases.requestForbidden }, { status: 403 });
    }
  }
  if (opts.requireJsonBody !== false) {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      return Response.json({ error: phrases.requestNeedJson }, { status: 415 });
    }
  }
  return null;
}
