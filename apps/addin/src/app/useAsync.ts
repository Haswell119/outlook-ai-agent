import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Re-run the loader. */
  reload: () => void;
  setData: (d: T | null) => void;
}

/** Minimal async loader with cancellation of stale results. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], enabled = true): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const run = useRef(0);

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
