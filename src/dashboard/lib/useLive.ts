import { useEffect, useState } from 'react';
import { api } from './api';
import { bumpLive } from './useApi';

const EVERY_MS = 5_000;

/** Polls the site's pulse while the tab is visible (for the online count). When `refresh` is on and new data has
 *  landed, every panel refreshes in place. */
export function useLive(siteId: string, refresh: boolean) {
  const [online, setOnline] = useState<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let version: string | null = null;
    let busy = false;
    const poll = () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      api<{ v: string; online: number }>(`/api/sites/${siteId}/pulse`)
        .then((r) => {
          if (!alive) return;
          setOnline(r.online);
          if (refresh && version !== null && r.v !== version) bumpLive();
          version = r.v;
        }, () => {})
        .finally(() => (busy = false));
    };
    poll();
    const id = setInterval(poll, EVERY_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [siteId, refresh]);

  return online;
}
