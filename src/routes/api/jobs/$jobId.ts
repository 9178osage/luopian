import { createFileRoute } from "@tanstack/react-router";

import { copy, parseLocale } from "@/lib/i18n";
import { guardStudioMutation } from "@/lib/downloader/request-guard";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const Route = createFileRoute("/api/jobs/$jobId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const phrases = copy(parseLocale(new URL(request.url).searchParams.get("lang")));
        if (!ID.test(params.jobId)) return Response.json({ error: phrases.jobMissing }, { status: 404 });
        const { getJob } = await import("@/lib/downloader/engine.server");
        const job = getJob(params.jobId);
        if (!job) return Response.json({ error: phrases.jobMissing }, { status: 404 });
        return Response.json(job);
      },
      DELETE: async ({ params, request }) => {
        // Cancel: no JSON body, but still reject cross-origin when Origin is present.
        const guarded = guardStudioMutation(request, { requireJsonBody: false });
        if (guarded) return guarded;
        const phrases = copy(parseLocale(new URL(request.url).searchParams.get("lang")));
        if (!ID.test(params.jobId)) return Response.json({ error: phrases.jobMissing }, { status: 404 });
        const { cancelJob } = await import("@/lib/downloader/engine.server");
        const job = cancelJob(params.jobId);
        if (!job) return Response.json({ error: phrases.jobMissing }, { status: 404 });
        return Response.json(job);
      },
    },
  },
});
