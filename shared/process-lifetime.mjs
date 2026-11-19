import { setTimeout as sleep } from "node:timers/promises";

/** @param {number} pid Process ID, or a negative process group ID on Unix. */
export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH";
  }
}
/** @param {number} pid Process ID, or a negative process group ID on Unix. */
export async function waitForProcessExit(pid) {
  const deadline = performance.now() + 3000;
  while (processIsAlive(pid)) {
    if (performance.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}
