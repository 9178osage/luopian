import { createFileRoute } from "@tanstack/react-router";

import { Studio } from "@/components/downloader/studio";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <Studio />;
}
