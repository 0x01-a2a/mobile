/**
 * useRegionGate — detects whether AI brain features are available in the
 * current region. Resolves once on mount; result is stable for the session.
 *
 * brainAvailable: false in mainland China (CHN / CN storefront or locale).
 * loading: true until the native check completes.
 */
import { useEffect, useState } from 'react';
import { NodeModule } from '../native/NodeModule';

interface RegionGate {
  loading: boolean;
  region: string;
  brainAvailable: boolean;
}

const cache: { resolved: boolean; gate: RegionGate } = {
  resolved: false,
  gate: { loading: true, region: '', brainAvailable: true },
};

export function useRegionGate(): RegionGate {
  const [gate, setGate] = useState<RegionGate>(cache.gate);

  useEffect(() => {
    if (cache.resolved) {
      setGate(cache.gate);
      return;
    }
    NodeModule.getRegion()
      .then(({ region, brainAvailable }) => {
        const result: RegionGate = { loading: false, region, brainAvailable };
        cache.resolved = true;
        cache.gate = result;
        setGate(result);
      })
      .catch(() => {
        // On error, default to available — don't block users on detection failure.
        const result: RegionGate = { loading: false, region: '', brainAvailable: true };
        cache.resolved = true;
        cache.gate = result;
        setGate(result);
      });
  }, []);

  return gate;
}
