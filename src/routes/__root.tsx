import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { LocaleProvider } from "@/components/locale-provider";
import { AuthProvider } from "@/lib/auth/provider";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "落片" },
      {
        name: "description",
        content: "贴上视频链接，按画质、音频或字幕下载。",
      },
      { name: "theme-color", content: "#0e0f11" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      {
        rel: "stylesheet",
        href: "https://fonts.bunny.net/css?family=ibm-plex-sans:400,500,600|ibm-plex-mono:400,500",
      },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
  }),
  component: () => (
    <html lang="zh-Hans" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <PreviewHostBridge />
        <LocaleProvider>
          <AuthProvider>
            <Outlet />
          </AuthProvider>
        </LocaleProvider>
        <Scripts />
      </body>
    </html>
  ),
});
