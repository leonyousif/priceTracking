'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiFailure } from '@/lib/types';

type Envelope = ApiFailure | { success: true };
type Success<T> = Extract<T, { success: true }>;

export async function requestApi<T extends Envelope>(url: string, init?: RequestInit): Promise<Success<T>> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('success' in body)) throw new Error('Invalid server response');
  if (!response.ok || body.success !== true) {
    const errors = 'errors' in body && body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : [];
    const message = errors.flat().find((value): value is string => typeof value === 'string');
    throw new Error(message || (response.ok ? 'Request was rejected' : `Request failed (${response.status})`));
  }
  return body as Success<T>;
}

/** One request at a time per resource; URL cleanup also guards fetches that ignore abort. */
export function useApiResource<T extends Envelope>(url: string | null, options?: {
  pollMs: number; shouldPoll(data: Success<T>): boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ url: string; data: Success<T> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => void>(() => {});
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    if (!url) { setLoading(false); setError(null); return; }
    const controller = new AbortController();
    let active = true;
    let running = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: Success<T> | undefined;
    async function run() {
      if (!active) return;
      clearTimeout(timer);
      if (running) { queued = true; return; }
      running = true;
      setLoading(true);
      try {
        const data = await requestApi<T>(url!, { signal: controller.signal });
        if (!active) return;
        latest = data;
        setSnapshot({ url: url!, data });
        setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Network request failed');
      } finally {
        running = false;
        if (active) {
          setLoading(false);
          if (queued) { queued = false; void run(); }
          else if (latest && optionsRef.current?.shouldPoll(latest)) {
            timer = setTimeout(() => void run(), optionsRef.current.pollMs);
          }
        }
      }
    }
    refreshRef.current = () => void run();
    setError(null);
    void run();
    return () => { active = false; controller.abort(); clearTimeout(timer); refreshRef.current = () => {}; };
  }, [url]);

  return { data: snapshot?.url === url ? snapshot.data : null, error, loading, refresh };
}

/** Mutation callbacks are retired on unmount, including transports that ignore cancellation. */
export function useApiMutation() {
  const mounted = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, []);
  return async function mutate<T extends Envelope>(url: string, init: RequestInit, callbacks: {
    success(data: Success<T>): void; error(message: string): void; settled?(): void;
  }) {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const data = await requestApi<T>(url, { ...init, signal: controller.signal });
      if (mounted.current && !controller.signal.aborted) callbacks.success(data);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) callbacks.error(cause instanceof Error ? cause.message : 'Network request failed');
    } finally {
      controllers.current.delete(controller);
      if (mounted.current && !controller.signal.aborted) callbacks.settled?.();
    }
  };
}
