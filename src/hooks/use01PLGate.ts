/**
 * use01PLGate — checks whether the user's wallets collectively hold enough
 * 01PL tokens to unlock "Agent Presence" premium features.
 *
 * Checks both the hot wallet (agent on-device key) and the linked cold wallet
 * in parallel, summing the combined balance against PRESENCE_THRESHOLD.
 *
 * Single-tier gate: combined hold ≥ PRESENCE_THRESHOLD → eligible.
 */
import { useState, useEffect, useCallback } from 'react';

// ── Gate configuration — easy to change ───────────────────────────────────
/** Solana mainnet mint address for the 01PL platform token. */
export const PILOT_TOKEN_MINT = '2MchUMEvadoTbSvC4b1uLAmEhv8Yz8ngwEt24q21BAGS';

/** Minimum combined 01PL balance required to unlock Agent Presence. */
export const PRESENCE_THRESHOLD = 5_000;

const RPC_URL = 'https://api.mainnet-beta.solana.com';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // recheck every 5 min

/** Internal stored state — does not include `refresh` (added at return time). */
interface PLGateInternalState {
  eligible: boolean;
  balance: number;
  loading: boolean;
  error: boolean;
}

export interface PLGateState extends PLGateInternalState {
  /** Manually trigger a re-fetch (e.g. after an RPC error). */
  refresh: () => void;
}

async function fetchWalletBalance(
  walletAddress: string,
  signal: AbortSignal,
): Promise<{ raw: bigint; decimals: number }> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [
        walletAddress,
        { mint: PILOT_TOKEN_MINT },
        { encoding: 'jsonParsed' },
      ],
    }),
    signal,
  });
  const json = await res.json();
  const accounts: any[] = json?.result?.value ?? [];
  let raw = BigInt(0);
  let decimals = 6;
  for (const acct of accounts) {
    const ta = acct?.account?.data?.parsed?.info?.tokenAmount;
    if (ta) {
      raw += BigInt(ta.amount ?? '0');
      decimals = ta.decimals ?? decimals;
    }
  }
  return { raw, decimals };
}

/**
 * Pass an array of wallet addresses (hot + cold). Null/undefined entries are
 * filtered out. Re-runs automatically when the array reference changes.
 */
export function use01PLGate(walletAddresses: (string | null | undefined)[]): PLGateState {
  // Stable key so useCallback/useEffect only re-fire when addresses actually change
  const addrKey = walletAddresses.filter(Boolean).join(',');

  const [state, setState] = useState<PLGateInternalState>({
    eligible: false,
    balance: 0,
    loading: addrKey.length > 0,
    error: false,
  });

  const fetchBalance = useCallback(
    async (cancelled: { v: boolean }) => {
      const addresses = addrKey.split(',').filter(Boolean);
      if (addresses.length === 0) {
        if (!cancelled.v) setState({ eligible: false, balance: 0, loading: false, error: false });
        return;
      }
      if (!cancelled.v) setState(prev => ({ ...prev, loading: true, error: false }));
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      try {
        const results = await Promise.all(
          addresses.map(addr => fetchWalletBalance(addr, controller.signal)),
        );
        let totalRaw = BigInt(0);
        let decimals = 6;
        for (const r of results) {
          totalRaw += r.raw;
          decimals = r.decimals; // consistent across accounts for the same mint
        }
        const threshold = BigInt(PRESENCE_THRESHOLD) * BigInt(10 ** decimals);
        const eligible = totalRaw >= threshold;
        const balance = Number(totalRaw) / Math.pow(10, decimals);
        clearTimeout(timeoutId);
        if (!cancelled.v) setState({ eligible, balance, loading: false, error: false });
      } catch {
        clearTimeout(timeoutId);
        if (!cancelled.v) setState(prev => ({ ...prev, loading: false, error: true }));
      }
    },
    [addrKey],
  );

  useEffect(() => {
    const cancelled = { v: false };
    fetchBalance(cancelled);
    const interval = setInterval(() => fetchBalance(cancelled), POLL_INTERVAL_MS);
    return () => {
      cancelled.v = true;
      clearInterval(interval);
    };
  }, [fetchBalance]);

  const refresh = useCallback(() => {
    const cancelled = { v: false };
    fetchBalance(cancelled);
  }, [fetchBalance]);

  return { ...state, refresh };
}
