import { useEffect, useRef, useState } from 'react';
import { api } from './api';

const FRESH_MS = 30_000;
const MAX_ENTRIES = 300;
const cache = new Map<string, { data: unknown; at: number }>();
const inflight = new Map<string, Promise<unknown>>();

function put(key: string, data: unknown) {
  cache.delete(key);
  cache.set(key, { data, at: Date.now() });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

const cached = <T,>(key: string | null) => (key ? ((cache.get(key)?.data as T) ?? null) : null);
const fresh = (key: string) => {
  const hit = cache.get(key);
  return !!hit && Date.now() - hit.at < FRESH_MS;
};

const keyOf = (url: string, reloadKey: number) => `${reloadKey}|${url}`;

/** Endpoint + breakdown dimension: what a panel shows, ignoring date range and filters. */
function viewOf(key: string) {
  const url = new URL(key.slice(key.indexOf('|') + 1), 'http://x');
  return `${url.pathname}|${url.searchParams.get('dim') ?? ''}`;
}

// ---- live updates: bumpLive() makes every mounted useApi refetch its URL in the background and swap data in place.
let liveTick = 0;
const liveListeners = new Set<() => void>();

export function bumpLive() {
  liveTick++;
  for (const entry of cache.values()) entry.at = 0;
  liveListeners.forEach((l) => l());
}

function useLiveTick() {
  const [tick, setTick] = useState(liveTick);
  useEffect(() => {
    const l = () => setTick(liveTick);
    liveListeners.add(l);
    return () => void liveListeners.delete(l);
  }, []);
  return tick;
}

function load<T>(url: string, reloadKey: number, force = false): Promise<T> {
  const key = keyOf(url, reloadKey);
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p || force) {
    p = api<T>(url)
      .then((d) => {
        put(key, d);
        return d;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Warm the cache for a URL (e.g. the other tabs of a panel) so switching to it is instant. */
export function prefetch(url: string, reloadKey = 0) {
  if (!fresh(keyOf(url, reloadKey))) load(url, reloadKey).catch(() => {});
}

/** Fetch `url` whenever it changes (or `reloadKey` bumps). `null` skips fetching.
 *  Cached responses show instantly and are revalidated in the background once older than 30s. */
export function useApi<T>(url: string | null, reloadKey = 0) {
  const key = url ? keyOf(url, reloadKey) : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; stale: boolean }>(() => ({
    key,
    data: cached<T>(key),
    stale: false,
  }));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const tick = useLiveTick();
  const seenTick = useRef(tick);

  // Switching URL: show that URL's cached data (or nothing) right away, never the previous URL's rows.
  if (state.key !== key) {
    const hit = cached<T>(key);
    // Keep the old data while a date/filter change loads (so charts don't blank out), but not across tabs.
    const sameView = !!state.key && !!key && viewOf(state.key) === viewOf(key);
    setState({ key, data: hit ?? (sameView ? state.data : null), stale: !hit && sameView && state.data !== null });
  }

  useEffect(() => {
    if (!url) return;
    let alive = true;
    setError(null);
    const k = keyOf(url, reloadKey);
    if (fresh(k)) {
      setLoading(false);
      return;
    }
    setLoading(!cache.has(k));
    load<T>(url, reloadKey)
      .then((d) => alive && setState({ key: k, data: d, stale: false }))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [url, reloadKey]);

  useEffect(() => {
    if (tick === seenTick.current) return;
    seenTick.current = tick;
    if (!url) return;
    let alive = true;
    const k = keyOf(url, reloadKey);
    load<T>(url, reloadKey, true).then(
      (d) => alive && setState((s) => (s.key === k ? { key: k, data: d, stale: false } : s)),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [tick]);

  const setData = (d: T | null | ((prev: T | null) => T | null)) =>
    setState((s) => {
      const next = typeof d === 'function' ? (d as (p: T | null) => T | null)(s.data) : d;
      if (s.key) put(s.key, next);
      return { key: s.key, data: next, stale: false };
    });

  /** `stale`: showing the previous range/filter's data while this one loads. */
  return { data: state.data, stale: state.stale, error, loading, setData };
}
