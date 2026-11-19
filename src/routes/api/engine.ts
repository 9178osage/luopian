import { createFileRoute } from "@tanstack/react-router";

import { desktopDownloads, jobJson } from "@/lib/downloader/request-guard";

export const Route = createFileRoute("/api/engine")({
  server: {
    middleware: [desktopDownloads],
    handlers: {
      GET: async ({ request }) => {
        const { getEngineInfo } = await import("@/lib/downloader/engine.server");
        return jobJson(
          await getEngineInfo(new URL(request.url).searchParams.get("refresh") === "1"),
        );
      },
    },
  },
});
