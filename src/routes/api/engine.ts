import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/engine")({
  server: {
    handlers: {
      GET: async () => {
        const { getEngineInfo } = await import("@/lib/downloader/engine.server");
        const info = await getEngineInfo();
        return Response.json(info);
      },
    },
  },
});
