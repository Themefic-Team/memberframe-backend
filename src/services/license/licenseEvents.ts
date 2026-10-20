/**
 * The push half of the license (19-pro-lock-and-trial.md 5.1). The plugin keeps
 * one stream open while its panel is open (`GET /api/plugin/events`), and every
 * change to a project's license reaches it at once, so the panel can rewrite
 * the components' baked lines and every canvas instance locks or unlocks
 * without anything asking the server on a timer.
 *
 * Anything that changes a license already calls `invalidateLicense`, which
 * calls `emitLicenseChanged`: the trial-end job, billing, the trial start.
 *
 * In memory, so it reaches the streams held by this process only. That is
 * right while the backend is one process (the Dockerfile); more than one
 * would need a shared channel such as Redis pub/sub, as the rate limiter would.
 */

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

/** Call `listener` whenever this site's license changes. Returns the unsubscribe. */
export function onLicenseChanged(siteId: string, listener: Listener): () => void {
  let set = listeners.get(siteId);
  if (!set) {
    set = new Set();
    listeners.set(siteId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(siteId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(siteId);
  };
}

/** Tell this site's open streams, or every stream when no site is named. */
export function emitLicenseChanged(siteId?: string): void {
  const targets = siteId ? [listeners.get(siteId)] : [...listeners.values()];
  for (const set of targets) {
    if (!set) continue;
    for (const listener of [...set]) {
      try {
        listener();
      } catch {
        // One broken stream never stops the others.
      }
    }
  }
}

/** Open streams for a site, for tests. */
export function listenerCount(siteId: string): number {
  return listeners.get(siteId)?.size ?? 0;
}
