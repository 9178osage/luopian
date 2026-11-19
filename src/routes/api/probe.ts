import { createFileRoute } from "@tanstack/react-router";

import {
  desktopDownloads,
  guardStudioMutation,
  jobJson,
  readDownloadRequest,
} from "@/lib/downloader/request-guard";
import { parseLocale } from "@/lib/i18n";

export const Route = createFileRoute("/api/probe")({
  server: {
    middleware: [desktopDownloads],
    handlers: {
      POST: async ({ request }) => {
        const guarded = guardStudioMutation(request);
        if (guarded) return guarded;
        const input = await readDownloadRequest(request);
        if (input instanceof Response) return input;
        const body =
          input && typeof input === "object" ? (input as { url?: unknown; lang?: unknown }) : {};
        const locale = parseLocale(body.lang ?? new URL(request.url).searchParams.get("lang"));
        const { DownloadError } = await import("@/lib/downloader/engine.server");
        const { probeVideo } = await import("@/lib/downloader/probe.server");
        try {
          return jobJson(await probeVideo(body.url, locale, request.signal));
        } catch (error) {
          if (error instanceof DownloadError)
            return jobJson({ error: error.message }, error.status);
          throw error;
        }
      },
    },
  },
});
