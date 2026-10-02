import { createFileRoute } from "@tanstack/react-router";

import { copy, parseLocale } from "@/lib/i18n";

export const Route = createFileRoute("/api/probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as { url?: string; lang?: string } | null;
        const locale = parseLocale(body?.lang);
        try {
          const { probeUrl } = await import("@/lib/downloader/engine.server");
          const probe = await probeUrl(body?.url ?? "", locale);
          return Response.json(probe);
        } catch (error) {
          const message = error instanceof Error ? error.message : copy(locale).videoInfo;
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },
  },
});
