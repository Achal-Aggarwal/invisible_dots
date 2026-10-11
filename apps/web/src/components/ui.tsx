"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Load data on mount and whenever `key` changes. Answers that arrive after a
 * newer load started are dropped, so a slow response never overwrites a
 * fresh one. The object returned is the same until one of its fields changes,
 * so a memo or a context value built from it changes only with it.
 */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  const reload = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    loader
      .current()
      .then((value) => {
        if (mine !== generation.current) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (mine !== generation.current) return;
        setError(err);
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    // Another key is another resource: what the last one said (its data, its error) is not this one's.
    setData(undefined);
    setError(null);
    reload();
  }, [key, reload]);

  return useMemo(() => ({ data, error, loading, reload }), [data, error, loading, reload]);
}

/** Run an action, tracking its pending state and error. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, setError, run };
}
