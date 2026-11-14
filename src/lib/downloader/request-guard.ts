import { parseLocale } from "../i18n.ts";
import { downloadMessages } from "./messages.ts";

const MAX_REQUEST_BYTES = 8 * 1024;
export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function jobJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

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

export async function readDownloadRequest(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let remaining = MAX_REQUEST_BYTES;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode()) as unknown;
      remaining -= value.byteLength;
      if (remaining < 0) {
        void reader.cancel().catch(() => undefined);
        return jobJson(
          {
            error: downloadMessages(parseLocale(new URL(request.url).searchParams.get("lang")))
              .requestTooLarge,
          },
          413,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
