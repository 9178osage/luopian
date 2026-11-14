import { createFileRoute } from "@tanstack/react-router";

import { jobJson } from "@/lib/downloader/request-guard";

export const Route = createFileRoute("/api/engine")({
  server: {
    handlers: {
      GET: async () => {
        const { getEngineInfo } = await import("@/lib/downloader/engine.server");
        return jobJson(await getEngineInfo());
      },
    },
  },
});
