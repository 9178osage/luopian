import { createFileRoute } from "@tanstack/react-router";

import { parseLocale } from "@/lib/i18n";
import { downloadMessages } from "@/lib/downloader/messages";
import { guardStudioMutation, jobJson, readDownloadRequest } from "@/lib/downloader/request-guard";

export const Route = createFileRoute("/api/jobs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const locale = parseLocale(new URL(request.url).searchParams.get("lang"));
        const { listJobs } = await import("@/lib/downloader/engine.server");
        try {
          return jobJson(await listJobs());
        } catch {
          return jobJson({ error: downloadMessages(locale).storage }, 500);
        }
      },
      POST: async ({ request }) => {
        const guarded = guardStudioMutation(request);
        if (guarded) return guarded;
        const input = await readDownloadRequest(request);
        if (input instanceof Response) return input;
        const body =
          input && typeof input === "object"
            ? (input as { url?: unknown; quality?: unknown; lang?: unknown })
            : {};
        const locale = parseLocale(body.lang ?? new URL(request.url).searchParams.get("lang"));
        const { DownloadError, startJob } = await import("@/lib/downloader/engine.server");
        try {
          return jobJson(
            await startJob({ url: body.url, quality: body.quality, lang: locale }),
            201,
          );
        } catch (error) {
          if (error instanceof DownloadError)
            return jobJson({ error: error.message }, error.status);
          return jobJson({ error: downloadMessages(locale).storage }, 500);
        }
      },
    },
  },
});
