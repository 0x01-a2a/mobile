/**
 * useTTS — OS-native text-to-speech for reading messages aloud.
 *
 * Uses React Native's built-in TTS module (no extra dependency):
 * - iOS: AVSpeechSynthesizer (free, on-device)
 * - Android: android.speech.tts.TextToSpeech (free, on-device)
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { NativeModules, Platform } from 'react-native';

// React Native doesn't ship a TTS module, but we can use the phone bridge
// endpoint which already exposes TTS on both platforms. For simplicity,
// use the bridge at 127.0.0.1:9092 which calls AVSpeechSynthesizer (iOS)
// or Android TTS. Falls back to doing nothing if bridge is unavailable.

const BRIDGE_URL = 'http://127.0.0.1:9092';

export interface UseTTSResult {
  /** Whether TTS is currently speaking. */
  speaking: boolean;
  /** Speak the given text. Stops any current speech first. */
  speak: (text: string) => void;
  /** Stop speaking. */
  stop: () => void;
}

export function useTTS(): UseTTSResult {
  const [speaking, setSpeaking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bridgeTokenRef = useRef<string | null>(null);

  // Load bridge token once
  useEffect(() => {
    (async () => {
      try {
        const { NodeModule } = require('../native/NodeModule');
        const auth = await NodeModule.getLocalAuthConfig();
        bridgeTokenRef.current = auth?.bridgeToken ?? auth?.phoneBridgeToken ?? null;
      } catch {
        bridgeTokenRef.current = null;
      }
    })();
  }, []);

  const speak = useCallback((text: string) => {
    if (!text.trim()) return;

    // Abort previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSpeaking(true);

    // Call the phone bridge TTS endpoint
    const token = bridgeTokenRef.current;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['x-bridge-token'] = token;

    fetch(`${BRIDGE_URL}/phone/tts/speak`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: text.slice(0, 4000) }),
      signal: controller.signal,
    })
      .then(() => {
        // TTS is fire-and-forget — the bridge speaks asynchronously.
        // Estimate speaking duration: ~150 words/min = ~2.5 words/sec.
        const words = text.split(/\s+/).length;
        const estimatedMs = Math.max(1000, (words / 2.5) * 1000);
        setTimeout(() => {
          if (!controller.signal.aborted) setSpeaking(false);
        }, estimatedMs);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSpeaking(false);
      });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setSpeaking(false);
    // Fire stop request to bridge (best-effort)
    const token = bridgeTokenRef.current;
    const headers: Record<string, string> = {};
    if (token) headers['x-bridge-token'] = token;
    fetch(`${BRIDGE_URL}/phone/tts/stop`, { method: 'POST', headers }).catch(() => {});
  }, []);

  return { speaking, speak, stop };
}
