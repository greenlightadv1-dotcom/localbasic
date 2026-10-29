'use client';

import { useCallback, useEffect, useState } from 'react';
import { isSectorKey, type SectorKey } from './sectors';

const EVENT = 'lb-sector-change';

/**
 * The sector a visitor is looking at, shared by every section of the landing
 * page through the URL hash (#restaurant, #retail, #clinic). The hero's
 * chips are plain links to those anchors, so they work before hydration and
 * can be shared; the switcher and the role tour follow along, so picking
 * "clinics" once tailors the whole page.
 */
export function useSector(initial: SectorKey = 'restaurant') {
  const [sector, setSectorState] = useState<SectorKey>(initial);

  useEffect(() => {
    const read = () => {
      const h = window.location.hash.replace('#', '');
      if (isSectorKey(h)) setSectorState(h);
    };
    const onCustom = (e: Event) => {
      const k = (e as CustomEvent<string>).detail;
      if (isSectorKey(k)) setSectorState(k);
    };
    read();
    window.addEventListener('hashchange', read);
    window.addEventListener(EVENT, onCustom);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener(EVENT, onCustom);
    };
  }, []);

  /** Switch without jumping the page: the hash is replaced, not navigated to. */
  const setSector = useCallback((k: SectorKey) => {
    setSectorState(k);
    try { window.history.replaceState(null, '', `#${k}`); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: k }));
  }, []);

  return [sector, setSector] as const;
}
