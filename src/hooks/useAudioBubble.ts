/**
 * useAudioBubble — record voice messages and play back audio bubbles.
 *
 * Uses the phone bridge (127.0.0.1:9092) for recording and the Web Audio API
 * (via react-native Audio) for playback. No third-party native audio package.
 *
 * Recording: POST /phone/audio/record on the bridge (returns file path).
 * Playback: uses RN's built-in fetch + audio playback via the bridge TTS endpoint
 *           or a simple Audio element for local files.
 *
 * Also generates TTS audio files for agent messages via the phone bridge.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Platform } from 'react-native';

const BRIDGE_URL = 'http://127.0.0.1:9092';
const NODE_URL = 'http://127.0.0.1:9090';

// ── Recording ─────────────────────────────────────────────────────────────────

export interface RecordingResult {
  uri: string;
  durationMs: number;
}

export interface UseRecorderResult {
  recording: boolean;
  durationMs: number;
  start: () => Promise<void>;
  stop: () => Promise<RecordingResult | null>;
}

/**
 * Records audio via the phone bridge.
 * Start begins recording; stop ends it and returns the file path + duration.
 */
export function useRecorder(): UseRecorderResult {
  const [recording, setRecording] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const startTimeRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bridgeTokenRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { NodeModule } = require('../native/NodeModule');
        const auth = await NodeModule.getLocalAuthConfig();
        bridgeTokenRef.current = (auth as any)?.phoneBridgeToken ?? auth?.gatewayToken ?? null;
      } catch {
        bridgeTokenRef.current = null;
      }
    })();
  }, []);

  const start = useCallback(async () => {
    setDurationMs(0);
    startTimeRef.current = Date.now();
    setRecording(true);

    // Start a timer to show elapsed duration
    intervalRef.current = setInterval(() => {
      setDurationMs(Date.now() - startTimeRef.current);
    }, 200);

    // Tell the bridge to start recording (fire-and-forget; the stop call retrieves the file)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bridgeTokenRef.current) headers['x-bridge-token'] = bridgeTokenRef.current;
    fetch(`${BRIDGE_URL}/phone/audio/record`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'start' }),
    }).catch(() => {});
  }, []);

  const stop = useCallback(async (): Promise<RecordingResult | null> => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    const finalDuration = Date.now() - startTimeRef.current;
    setRecording(false);
    setDurationMs(finalDuration);

    // Tell the bridge to stop recording and return the file path
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bridgeTokenRef.current) headers['x-bridge-token'] = bridgeTokenRef.current;

    try {
      const resp = await fetch(`${BRIDGE_URL}/phone/audio/record`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'stop' }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const uri = data.file_path
          ? Platform.OS === 'ios' ? data.file_path : `file://${data.file_path}`
          : '';
        return { uri, durationMs: data.duration_ms ?? finalDuration };
      }
    } catch { /* bridge unavailable */ }

    // Fallback: return duration without a file (STT text still works for the message)
    return { uri: '', durationMs: finalDuration };
  }, []);

  return { recording, durationMs, start, stop };
}

// ── Playback ──────────────────────────────────────────────────────────────────

export interface UsePlayerResult {
  playing: boolean;
  currentMs: number;
  play: (uri: string) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Plays audio files via the phone bridge TTS/playback endpoint.
 * For local file:// URIs, asks the bridge to play them.
 * For remote https:// URLs, streams directly.
 */
export function usePlayer(): UsePlayerResult {
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);
  const bridgeTokenRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { NodeModule } = require('../native/NodeModule');
        const auth = await NodeModule.getLocalAuthConfig();
        bridgeTokenRef.current = (auth as any)?.phoneBridgeToken ?? auth?.gatewayToken ?? null;
      } catch {
        bridgeTokenRef.current = null;
      }
    })();
  }, []);

  const play = useCallback(async (uri: string) => {
    if (!uri) return;
    setPlaying(true);
    setCurrentMs(0);
    startRef.current = Date.now();

    intervalRef.current = setInterval(() => {
      setCurrentMs(Date.now() - startRef.current);
    }, 200);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bridgeTokenRef.current) headers['x-bridge-token'] = bridgeTokenRef.current;

    try {
      await fetch(`${BRIDGE_URL}/phone/audio/play`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file_path: uri.replace('file://', '') }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best effort */ }

    // Estimate when playback ends (bridge doesn't notify)
    // For now just stop after a reasonable timeout
    setTimeout(() => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setPlaying(false);
    }, 60000); // max 60s
  }, []);

  const stop = useCallback(async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setPlaying(false);

    const headers: Record<string, string> = {};
    if (bridgeTokenRef.current) headers['x-bridge-token'] = bridgeTokenRef.current;
    fetch(`${BRIDGE_URL}/phone/audio/stop`, { method: 'POST', headers }).catch(() => {});
  }, []);

  return { playing, currentMs, play, stop };
}

// ── TTS file generation ───────────────────────────────────────────────────────

/**
 * Generate a TTS audio file for a text message via the phone bridge.
 * Returns the file URI, or null if TTS fails.
 */
export async function generateTTSFile(
  text: string,
  bridgeToken: string | null,
): Promise<{ uri: string; durationMs: number } | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bridgeToken) headers['x-bridge-token'] = bridgeToken;

  try {
    // Try the file-generating endpoint first
    const resp = await fetch(`${BRIDGE_URL}/phone/tts/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(15000),
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.file_path) {
        return {
          uri: Platform.OS === 'ios' ? data.file_path : `file://${data.file_path}`,
          durationMs: data.duration_ms ?? estimateDuration(text),
        };
      }
    }
  } catch {
    // Fall through
  }

  // Fallback: fire-and-forget TTS (no audio file saved)
  try {
    await fetch(`${BRIDGE_URL}/phone/tts/speak`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(5000),
    });
    return { uri: '', durationMs: estimateDuration(text) };
  } catch {
    return null;
  }
}

function estimateDuration(text: string): number {
  const words = text.split(/\s+/).length;
  return Math.max(1000, (words / 2.5) * 1000);
}

// ── On-device podcast concat ──────────────────────────────────────────────────

/**
 * Concatenate audio files on-device via the local node API.
 */
export async function concatPodcastOnDevice(
  audioUris: string[],
  title: string,
  nodeToken: string | null,
): Promise<{ uri: string; durationMs: number } | null> {
  if (audioUris.length === 0) return null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (nodeToken) headers['Authorization'] = `Bearer ${nodeToken}`;

  const transcript = audioUris.map((uri, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: '',
    audio_uri: uri,
  }));

  try {
    const resp = await fetch(`${NODE_URL}/podcast/produce-local`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, transcript }),
      signal: AbortSignal.timeout(30000),
    });

    if (resp.ok) {
      const data = await resp.json();
      return {
        uri: data.audio_url ?? data.file_uri ?? '',
        durationMs: (data.duration_secs ?? 0) * 1000,
      };
    }
  } catch { /* node unavailable */ }

  if (audioUris.length === 1) {
    return { uri: audioUris[0], durationMs: 0 };
  }

  return null;
}

// ── Format helpers ────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
