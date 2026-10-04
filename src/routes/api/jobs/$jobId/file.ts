import { createFileRoute } from "@tanstack/react-router";

import { copy, parseLocale } from "@/lib/i18n";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const Route = createFileRoute("/api/jobs/$jobId/file")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const locale = parseLocale(new URL(request.url).searchParams.get("lang"));
        if (!ID.test(params.jobId)) {
          return Response.json({ error: copy(locale).fileMissing }, { status: 404 });
        }
        const { openJobFile } = await import("@/lib/downloader/engine.server");
        return openJobFile(params.jobId, locale);
      },
    },
  },
});
