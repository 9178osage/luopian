import { createFileRoute } from "@tanstack/react-router";

import { parseLocale } from "@/lib/i18n";
import { downloadMessages } from "@/lib/downloader/messages";
import {
  desktopDownloads,
  guardStudioMutation,
  jobJson,
  JOB_ID,
  readDownloadRequest,
} from "@/lib/downloader/request-guard";

async function jobResponse(request: Request, id: string, action: "status" | "cancel") {
  const messages = downloadMessages(parseLocale(new URL(request.url).searchParams.get("lang")));
  if (!JOB_ID.test(id)) return jobJson({ error: messages.missingJob }, 404);
  const { getJob, cancelJob } = await import("@/lib/downloader/engine.server");
  try {
    const job = await (action === "status" ? getJob(id) : cancelJob(id));
    return job ? jobJson(job) : jobJson({ error: messages.missingJob }, 404);
  } catch {
    return jobJson({ error: messages.storage }, 500);
  }
}

export const Route = createFileRoute("/api/jobs/$jobId")({
  server: {
    middleware: [desktopDownloads],
    handlers: {
      GET: async ({ params, request }) => jobResponse(request, params.jobId, "status"),
      DELETE: async ({ params, request }) =>
        guardStudioMutation(request, false) ?? jobResponse(request, params.jobId, "cancel"),
      POST: async ({ params, request }) => {
        const guarded = guardStudioMutation(request);
        if (guarded) return guarded;
        const input = await readDownloadRequest(request);
        if (input instanceof Response) return input;
        const body = input && typeof input === "object" ? (input as { lang?: unknown }) : null;
        const locale = parseLocale(body?.lang ?? new URL(request.url).searchParams.get("lang"));
        const messages = downloadMessages(locale);
        if (!body || Array.isArray(body)) return jobJson({ error: messages.invalidJson }, 400);
        if (!JOB_ID.test(params.jobId)) return jobJson({ error: messages.missingJob }, 404);
        const { DownloadError, retryJob } = await import("@/lib/downloader/engine.server");
        try {
          const job = await retryJob(params.jobId, locale);
          return job ? jobJson(job, 201) : jobJson({ error: messages.missingJob }, 404);
        } catch (error) {
          if (error instanceof DownloadError)
            return jobJson({ error: error.message }, error.status);
          return jobJson({ error: messages.storage }, 500);
        }
      },
    },
  },
});
