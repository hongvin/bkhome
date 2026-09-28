"use client";

/**
 * Service-worker registration.
 *
 * This is the ONE component S5 needs to mount for the PWA to be installable and
 * for the app shell to survive a tunnel. It renders nothing.
 *
 * S5 mounts it once in `app/layout.tsx`:
 *
 *     import { ServiceWorkerRegistrar } from "@/lib/offline";
 *     ...
 *     <body>
 *       {children}
 *       <ServiceWorkerRegistrar />
 *     </body>
 *
 * It deliberately lives in `lib/offline/` (S6's directory) rather than in
 * `app/` or `components/`, so no file outside this module's ownership changes.
 */

import { useEffect } from "react";

export const SERVICE_WORKER_PATH = "/sw.js";
export const DEFAULT_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export interface ServiceWorkerRegistrarProps {
  /** Public path of the service worker script. Default `"/sw.js"`. */
  swPath?: string;
  /** Registration scope. Default `"/"`. */
  scope?: string;
  /**
   * Register in development too. Off by default: a dev service worker caches
   * Next's HMR chunks and makes edits appear not to apply.
   */
  registerInDevelopment?: boolean;
  /** How often to check for a new service worker. 0 disables. Default 1 hour. */
  updateIntervalMs?: number;
  onRegistered?: (registration: ServiceWorkerRegistration) => void;
  onError?: (error: unknown) => void;
}

/**
 * Registers `/sw.js` and activates updates on the next load.
 */
export function ServiceWorkerRegistrar({
  swPath = SERVICE_WORKER_PATH,
  scope = "/",
  registerInDevelopment = false,
  updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS,
  onRegistered,
  onError,
}: ServiceWorkerRegistrarProps = {}): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production" && !registerInDevelopment) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const register = async (): Promise<void> => {
      try {
        const registration = await navigator.serviceWorker.register(swPath, { scope });
        if (cancelled) return;
        onRegistered?.(registration);

        const activateWhenInstalled = (worker: ServiceWorker | null): void => {
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        };
        activateWhenInstalled(registration.installing);
        registration.addEventListener("updatefound", () => {
          activateWhenInstalled(registration.installing);
        });

        if (updateIntervalMs > 0) {
          timer = setInterval(() => {
            void registration.update().catch(() => {
              // A failed update check is normal when offline; the cached shell stands.
            });
          }, updateIntervalMs);
        }
      } catch (error) {
        if (!cancelled) onError?.(error);
      }
    };

    void register();

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [swPath, scope, registerInDevelopment, updateIntervalMs, onRegistered, onError]);

  return null;
}
