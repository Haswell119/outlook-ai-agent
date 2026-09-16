/**
 * Connectivity state, shared by the API client and the UI banner.
 *
 * Two independent signals are combined:
 *  - the browser: `navigator.onLine` + the online/offline events. Reliable for
 *    "the laptop lost Wi-Fi", useless for "the backend is down".
 *  - the backend: every request reports success / network failure here, so a
 *    reachable network with an unreachable orchestrator still shows the banner.
 *
 * Nothing here blocks: the banner is informational, the pane keeps rendering
 * whatever it has (cached analyses stay usable offline).
 */

export type Connectivity = "online" | "offline" | "backend-unreachable";

type Listener = (state: Connectivity) => void;

const listeners = new Set<Listener>();

/** Consecutive network-level failures before we declare the backend down. */
const FAILURE_THRESHOLD = 2;

let failures = 0;
let backendDown = false;
let wired = false;

export function browserOnline(): boolean {
  try {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  } catch {
    return true;
  }
}

export function connectivity(): Connectivity {
  if (!browserOnline()) return "offline";
  return backendDown ? "backend-unreachable" : "online";
}

function emit(): void {
  const state = connectivity();
  for (const l of [...listeners]) {
    try {
      l(state);
    } catch {
      /* a listener must never break the others */
    }
  }
}

function wire(): void {
  if (wired || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  wired = true;
  window.addEventListener("online", () => {
    // Give the backend the benefit of the doubt when the network comes back.
    failures = 0;
    backendDown = false;
    emit();
  });
  window.addEventListener("offline", () => emit());
}

/** Subscribe to connectivity changes; returns an unsubscribe function. */
export function onConnectivityChange(listener: Listener): () => void {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by the API client after a network-level failure (not an HTTP error). */
export function reportNetworkFailure(): void {
  failures++;
  if (failures >= FAILURE_THRESHOLD && !backendDown) {
    backendDown = true;
    emit();
  }
}

/** Called by the API client after any successful response (even a 4xx). */
export function reportReachable(): void {
  failures = 0;
  if (backendDown) {
    backendDown = false;
    emit();
  }
}

/** Test seam. */
export function resetConnectivity(): void {
  failures = 0;
  backendDown = false;
}
