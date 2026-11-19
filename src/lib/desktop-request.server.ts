import type { AsyncLocalStorage } from "node:async_hooks";

const desktopRequest = Symbol.for("luopian.desktopRequest");

export function desktopRequestNonce() {
  return (globalThis as typeof globalThis & { [desktopRequest]?: AsyncLocalStorage<string> })[
    desktopRequest
  ]?.getStore();
}
