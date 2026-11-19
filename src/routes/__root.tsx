import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { LocaleProvider } from "@/components/locale-provider";
import { AuthProvider } from "@/lib/auth/provider";
import appCss from "../styles.css?url";

const desktopBuild = import.meta.env.MODE === "desktop";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "落片" },
      {
        name: "description",
        content: "贴上 YouTube 或哔哩哔哩视频链接，保存为 MP4 或 MP3。",
      },
      { name: "theme-color", content: "#11131a" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      ...(desktopBuild
        ? []
        : [
            { rel: "manifest", href: "/__grok/manifest.webmanifest" },
            { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
          ]),
    ],
  }),
  component: () => (
    <html lang="zh-Hans" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {!desktopBuild && <PreviewHostBridge />}
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
