/**
 * useOwnedAgents — aggregates all agents owned by this user.
 *
 * For now: one local agent slot + one hosted agent slot.
 * Returns an array so the rest of the UI is already multi-agent ready.
 */
import { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './useNodeApi';
import { useNode } from './useNode';

export interface OwnedAgent {
  id: string;
  name: string;
  mode: 'local' | 'hosted';
  nodeApiUrl: string;
  hostUrl?: string;
  status: 'running' | 'stopped';
}

const LOCAL_API = 'http://127.0.0.1:9090';

export function useOwnedAgents(): OwnedAgent[] {
  const identity  = useIdentity();
  const { status, config } = useNode();
  const [agents, setAgents] = useState<OwnedAgent[]>([]);

  useEffect(() => {
    const isHosted = Boolean(config.nodeApiUrl);

    if (isHosted) {
      AsyncStorage.multiGet([
        'zerox1:host_url',
        'zerox1:hosted_agent_id',
      ]).then(pairs => {
        const m = Object.fromEntries(pairs.map(([k, v]) => [k, v ?? '']));
        setAgents([{
          id:         m['zerox1:hosted_agent_id'] || identity?.agent_id || '',
          name:       identity?.name ?? 'hosted agent',
          mode:       'hosted',
          nodeApiUrl: config.nodeApiUrl!,
          hostUrl:    m['zerox1:host_url'] || config.nodeApiUrl,
          status:     'running',
        }]);
      }).catch(() => {});
    } else {
      setAgents([{
        id:         identity?.agent_id ?? '',
        name:       identity?.name ?? 'local agent',
        mode:       'local',
        nodeApiUrl: LOCAL_API,
        status:     status === 'running' ? 'running' : 'stopped',
      }]);
    }
  }, [identity?.agent_id, identity?.name, status, config.nodeApiUrl]);

  return agents;
}
