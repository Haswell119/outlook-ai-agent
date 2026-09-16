import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Re-run the loader. */
  reload: () => void;
  setData: (d: T | null) => void;
}

function sameDeps(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * Minimal keyed async loader.
 *
 * `deps` are a **key**, not just a re-run trigger: when they change, the value
 * already in state describes something else — another mailbox item, another
 * language, another selection — so it is dropped *during the render that sees
 * the new key*, before anything is painted.
 *
 * That is what fixes "I opened another email and the pane is stuck on the
 * previous one": the previous behaviour kept `data` until the new promise
 * resolved, so for as long as `body.getAsync` took (100 ms on a fast mailbox,
 * seconds on a slow one, forever if the read failed) the pane rendered the
 * *previous* message's subject, summary and actions next to the new skeleton.
 * Setting state during render is React's documented way to adjust state when
 * the inputs change; it re-renders immediately instead of committing the stale
 * tree.
 *
 * `run` is bumped at the same time, so a promise that resolves in the window
 * between this render and the effect cannot put the old value back either.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], enabled = true): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const run = useRef(0);
  const keyRef = useRef<unknown[]>(deps);

  if (!sameDeps(keyRef.current, deps)) {
    keyRef.current = deps;
    run.current++;
    if (data !== null) setData(null);
    if (error !== null) setError(null);
    if (enabled && !loading) setLoading(true);
  }

  useEffect(() => {
    if (!enabled) return;
    const myRun = ++run.current;
    setLoading(true);
    setError(null);
    loader()
      .then((d) => {
        if (run.current === myRun) setData(d);
      })
      .catch((e: unknown) => {
        if (run.current === myRun) setError(e);
      })
      .finally(() => {
        if (run.current === myRun) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
