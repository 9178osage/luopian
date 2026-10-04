import { createFileRoute } from "@tanstack/react-router";

import { copy, parseLocale } from "@/lib/i18n";

export const Route = createFileRoute("/api/jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as {
          url?: string;
          preset?: string;
          playlistEnd?: number | null;
          formatId?: string | null;
          videoOnly?: boolean;
          cookies?: string;
          pixivToken?: string;
          title?: string;
          lang?: string;
        } | null;
        const locale = parseLocale(body?.lang);
        const phrases = copy(locale);
        if (!body?.url || !body.preset) {
          return Response.json({ error: phrases.requestIncomplete }, { status: 400 });
        }
        try {
          const { startJob } = await import("@/lib/downloader/engine.server");
          const job = await startJob({
            url: body.url,
            preset: body.preset,
            playlistEnd: body.playlistEnd,
            formatId: body.formatId,
            videoOnly: body.videoOnly,
            cookies: body.cookies,
            pixivToken: body.pixivToken,
            title: body.title,
            lang: locale,
          });
          return Response.json(job);
        } catch (error) {
          const message = error instanceof Error ? error.message : phrases.cantStart;
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },
  },
});
