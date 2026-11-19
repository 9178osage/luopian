import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";

import { desktopRequestNonce } from "@/lib/desktop-request.server";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

const requestNonce = createIsomorphicFn().server(() => desktopRequestNonce());

export function getRouter() {
  return createRouter({
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    ssr: { nonce: requestNonce() },
  });
}
