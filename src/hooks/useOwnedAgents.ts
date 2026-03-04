/**
 * useOwnedAgents — aggregates all agents owned by this user.
 *
 * Modes:
 *   local  — node running on this phone
 *   hosted — node running on a remote host, connected via token
 *   linked — remote home-server agent claimed by agent_id lookup
 */
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './useNodeApi';
import { useNode } from './useNode';

export interface OwnedAgent {
  id: string;
  name: string;
  mode: 'local' | 'hosted' | 'linked';
  nodeApiUrl?: string;
  hostUrl?: string;
  status: 'running' | 'stopped' | 'unknown';
  ownerWallet?: string;
}

const LOCAL_API = 'http://127.0.0.1:9090';

// Module-level subscriber set so My.tsx can trigger a re-read after linking.
const linkedListeners = new Set<() => void>();

export function notifyLinkedAgentsUpdated(): void {
  linkedListeners.forEach(fn => fn());
}

export function useOwnedAgents(): OwnedAgent[] {
  const identity  = useIdentity();
  const { status, config } = useNode();
  const [primary, setPrimary] = useState<OwnedAgent[]>([]);
  const [linked, setLinked]   = useState<OwnedAgent[]>([]);

  // Local / hosted agent
  useEffect(() => {
    const isHosted = Boolean(config.nodeApiUrl);

    if (isHosted) {
      AsyncStorage.multiGet([
        'zerox1:host_url',
        'zerox1:hosted_agent_id',
      ]).then(pairs => {
        const m = Object.fromEntries(pairs.map(([k, v]) => [k, v ?? '']));
        setPrimary([{
          id:         m['zerox1:hosted_agent_id'] || identity?.agent_id || '',
          name:       identity?.name ?? 'hosted agent',
          mode:       'hosted',
          nodeApiUrl: config.nodeApiUrl!,
          hostUrl:    m['zerox1:host_url'] || config.nodeApiUrl,
          status:     'running',
        }]);
      }).catch(() => {});
    } else {
      setPrimary([{
        id:         identity?.agent_id ?? '',
        name:       identity?.name ?? 'local agent',
        mode:       'local',
        nodeApiUrl: LOCAL_API,
        status:     status === 'running' ? 'running' : 'stopped',
      }]);
    }
  }, [identity?.agent_id, identity?.name, status, config.nodeApiUrl]);

  // Linked agents (persisted in AsyncStorage, refreshed via notifyLinkedAgentsUpdated)
  const loadLinked = useCallback(() => {
    AsyncStorage.getItem('zerox1:linked_agents')
      .then(raw => {
        if (!raw) { setLinked([]); return; }
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setLinked(parsed);
          else setLinked([]);
        } catch { setLinked([]); }
      })
      .catch(() => setLinked([]));
  }, []);

  useEffect(() => {
    loadLinked();
    linkedListeners.add(loadLinked);
    return () => { linkedListeners.delete(loadLinked); };
  }, [loadLinked]);

  return [...primary, ...linked];
}
