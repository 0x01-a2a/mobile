/**
 * usePremium — checks premium status via aggregator + provides upgrade action.
 *
 * Premium = either 500k 01PL hold OR active USDC subscription ($9.99/30 days).
 *
 * The upgrade flow opens MoonPay to buy USDC on Solana, sent directly to
 * the operator wallet. After payment, the app verifies via POST /premium/subscribe.
 */
import { useState, useEffect, useCallback } from 'react';
import { Linking } from 'react-native';
import { AGGREGATOR_API } from './useNodeApi';
import { NodeModule } from '../native/NodeModule';

// MoonPay publishable API key (safe to embed in app — not a secret).
// Replace with your actual key from https://dashboard.moonpay.com
const MOONPAY_API_KEY = 'pk_live_01pilot_placeholder';

// Operator USDC wallet that receives premium payments.
// This is the wallet the aggregator checks for incoming transfers.
const OPERATOR_USDC_WALLET = ''; // TODO: set your operator wallet address

const PREMIUM_AMOUNT_USD = 9.99;

export interface PremiumState {
  /** Whether the agent has active premium (01PL or subscription). */
  isPremium: boolean;
  /** Source of premium: '01pl_holder', 'subscription', or null. */
  source: string | null;
  /** Unix timestamp when subscription expires (0 if 01PL holder). */
  expiresAt: number;
  /** Loading state. */
  loading: boolean;
  /** Open MoonPay to purchase USDC for premium subscription. */
  upgrade: () => void;
  /** Refresh premium status. */
  refresh: () => void;
}

export function usePremium(): PremiumState {
  const [isPremium, setIsPremium] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [loading, setLoading] = useState(true);

  const checkStatus = useCallback(async () => {
    try {
      const auth = await NodeModule.getLocalAuthConfig();
      // Get agent_id from identity endpoint
      const identityResp = await fetch('http://127.0.0.1:9090/identity', {
        headers: auth?.nodeApiToken ? { Authorization: `Bearer ${auth.nodeApiToken}` } : {},
      });
      if (!identityResp.ok) { setLoading(false); return; }
      const { agent_id } = await identityResp.json();
      if (!agent_id) { setLoading(false); return; }

      // Check aggregator for premium status
      const resp = await fetch(
        `${AGGREGATOR_API}/premium/status?agent_id=${agent_id}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        setIsPremium(data.premium === true);
        setSource(data.source ?? null);
        setExpiresAt(data.expires_at ?? 0);
      }
    } catch { /* offline */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const upgrade = useCallback(() => {
    if (!OPERATOR_USDC_WALLET) {
      // Fallback: open Jupiter to buy 01PL if operator wallet not configured
      Linking.openURL(
        `https://jup.ag/swap/SOL-2MchUMEvadoTbSvC4b1uLAmEhv8Yz8ngwEt24q21BAGS`,
      );
      return;
    }

    // Open MoonPay widget to buy USDC on Solana, sent to operator wallet
    const moonpayUrl = `https://buy.moonpay.com/?apiKey=${MOONPAY_API_KEY}` +
      `&currencyCode=usdc_sol` +
      `&walletAddress=${OPERATOR_USDC_WALLET}` +
      `&baseCurrencyAmount=${PREMIUM_AMOUNT_USD}` +
      `&showWalletAddressForm=false`;

    Linking.openURL(moonpayUrl);
  }, []);

  return { isPremium, source, expiresAt, loading, upgrade, refresh: checkStatus };
}
