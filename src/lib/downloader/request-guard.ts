import { createMiddleware } from "@tanstack/react-start";

import { desktopRequestNonce } from "../desktop-request.server.ts";
import { parseLocale } from "../i18n.ts";
import { downloadMessages } from "./messages.ts";

const MAX_REQUEST_BYTES = 96 * 1024;
export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function jobJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export const desktopDownloads = createMiddleware().server(({ next, request }) => {
  if (desktopRequestNonce()) return next();
  const locale = parseLocale(new URL(request.url).searchParams.get("lang"));
  return jobJson(
    {
      error:
        locale === "zh"
          ? "下载功能在落片桌面版中可用。"
          : "Downloads are available in the desktop app.",
    },
    404,
  );
});

export function guardStudioMutation(request: Request, requireJson = true): Response | null {
  const url = new URL(request.url);
  const text = downloadMessages(parseLocale(url.searchParams.get("lang")));
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return jobJson({ error: text.forbidden }, 403);
  }
  if (
    requireJson &&
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return jobJson({ error: text.invalidJson }, 415);
  }
  return null;
}

// Returns the JSON object body, or a 400/413 response that names the actual problem.
export async function readDownloadRequest(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const text = downloadMessages(parseLocale(new URL(request.url).searchParams.get("lang")));
  const reader = request.body?.getReader();
  if (!reader) return jobJson({ error: text.emptyRequest }, 400);
  const decoder = new TextDecoder();
  let remaining = MAX_REQUEST_BYTES;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      remaining -= value.byteLength;
      if (remaining < 0) {
        void reader.cancel().catch(() => undefined);
        return jobJson({ error: text.requestTooLarge }, 413);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return jobJson({ error: text.unreadableRequest }, 400);
  } finally {
    reader.releaseLock();
  }
  if (!body.trim()) return jobJson({ error: text.emptyRequest }, 400);
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return jobJson({ error: text.malformedJson }, 400);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return jobJson({ error: text.malformedJson }, 400);
  }
  return input as Record<string, unknown>;
}
