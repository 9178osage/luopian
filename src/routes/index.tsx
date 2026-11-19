import { createFileRoute } from "@tanstack/react-router";

import { Studio } from "@/components/downloader/studio";
import { useLocale } from "@/components/locale-provider";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { locale } = useLocale();
  if (import.meta.env.MODE === "desktop") return <Studio />;
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold">落片</h1>
      <p className="mt-3 text-muted">
        {locale === "zh"
          ? "用落片桌面版或命令行下载 YouTube、哔哩哔哩视频和文件直链。"
          : "Download YouTube and Bilibili videos and direct files with the Luopian desktop app or CLI."}
      </p>
      <a
        className="mt-4 inline-block text-accent underline"
        href="https://github.com/9178osage/luopian#readme"
      >
        {locale === "zh" ? "安装与使用说明" : "Installation and usage"}
      </a>
    </main>
  );
}
