import { createFileRoute } from "@tanstack/react-router";

import { parseLocale } from "@/lib/i18n";
import { downloadMessages } from "@/lib/downloader/messages";
import {
  desktopDownloads,
  guardStudioMutation,
  jobJson,
  readDownloadRequest,
} from "@/lib/downloader/request-guard";

export const Route = createFileRoute("/api/jobs")({
  server: {
    middleware: [desktopDownloads],
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
        const body: {
          url?: unknown;
          urls?: unknown;
          quality?: unknown;
          output?: unknown;
          accelerate?: unknown;
          lang?: unknown;
        } = input;
        const locale = parseLocale(body.lang ?? new URL(request.url).searchParams.get("lang"));
        const { DownloadError, enqueueJobs, startJob } =
          await import("@/lib/downloader/engine.server");
        const options = { ...body, lang: locale };
        try {
          return jobJson(
            body.urls === undefined ? await startJob(options) : await enqueueJobs(options),
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
