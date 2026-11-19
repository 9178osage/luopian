import { createFileRoute } from "@tanstack/react-router";

import { parseLocale } from "@/lib/i18n";
import { downloadMessages } from "@/lib/downloader/messages";
import { desktopDownloads, jobJson, JOB_ID } from "@/lib/downloader/request-guard";

export const Route = createFileRoute("/api/jobs/$jobId/file")({
  server: {
    middleware: [desktopDownloads],
    handlers: {
      GET: async ({ params, request }) => {
        const locale = parseLocale(new URL(request.url).searchParams.get("lang"));
        const messages = downloadMessages(locale);
        if (!JOB_ID.test(params.jobId)) return jobJson({ error: messages.missingFile }, 404);
        const { openJobFile } = await import("@/lib/downloader/engine.server");
        try {
          return await openJobFile(params.jobId, locale);
        } catch {
          return jobJson({ error: messages.storage }, 500);
        }
      },
    },
  },
});
