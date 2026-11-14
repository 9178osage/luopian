import { createFileRoute } from "@tanstack/react-router";

import { parseLocale } from "@/lib/i18n";
import { downloadMessages } from "@/lib/downloader/messages";
import { guardStudioMutation, jobJson, JOB_ID } from "@/lib/downloader/request-guard";

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
    handlers: {
      GET: async ({ params, request }) => jobResponse(request, params.jobId, "status"),
      DELETE: async ({ params, request }) =>
        guardStudioMutation(request, false) ?? jobResponse(request, params.jobId, "cancel"),
    },
  },
});
