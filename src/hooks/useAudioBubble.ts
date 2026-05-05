/**
 * useAudioBubble — record voice messages and play back audio bubbles.
 *
 * Uses react-native-audio-recorder-player:
 * - Records to a temp file (m4a on iOS, mp4 on Android)
 * - Plays back any local audio URI
 * - Returns duration for display in voice bubbles
 *
 * Also generates TTS audio files for agent messages via the phone bridge.
 */
import { useState, useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';

const recorder = new (AudioRecorderPlayer as any)();

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

export function useRecorder(): UseRecorderResult {
  const [recording, setRecording] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const pathRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    const ext = Platform.OS === 'ios' ? 'm4a' : 'mp4';
    const path = Platform.select({
      ios: `voice_${Date.now()}.${ext}`,
      android: `/data/user/0/${require('../../app.json').name}/cache/voice_${Date.now()}.${ext}`,
    }) ?? `voice_${Date.now()}.${ext}`;

    pathRef.current = path;
    setDurationMs(0);
    setRecording(true);

    await recorder.startRecorder(path);
    recorder.addRecordBackListener((e: any) => {
      setDurationMs(Math.floor(e.currentPosition));
    });
  }, []);

  const stop = useCallback(async (): Promise<RecordingResult | null> => {
    try {
      const uri = await recorder.stopRecorder();
      recorder.removeRecordBackListener();
      setRecording(false);
      const finalDuration = durationMs;
      return { uri, durationMs: finalDuration };
    } catch {
      setRecording(false);
      return null;
    }
  }, [durationMs]);

  return { recording, durationMs, start, stop };
}

// ── Playback ──────────────────────────────────────────────────────────────────

export interface UsePlayerResult {
  playing: boolean;
  currentMs: number;
  play: (uri: string) => Promise<void>;
  stop: () => Promise<void>;
}

export function usePlayer(): UsePlayerResult {
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);

  const play = useCallback(async (uri: string) => {
    setPlaying(true);
    setCurrentMs(0);
    await recorder.startPlayer(uri);
    recorder.addPlayBackListener((e: any) => {
      setCurrentMs(Math.floor(e.currentPosition));
      if (e.currentPosition >= e.duration) {
        setPlaying(false);
        recorder.stopPlayer();
        recorder.removePlayBackListener();
      }
    });
  }, []);

  const stop = useCallback(async () => {
    await recorder.stopPlayer();
    recorder.removePlayBackListener();
    setPlaying(false);
  }, []);

  return { playing, currentMs, play, stop };
}

// ── TTS file generation ───────────────────────────────────────────────────────

const BRIDGE_URL = 'http://127.0.0.1:9092';

/**
 * Generate a TTS audio file for a text message via the phone bridge.
 * Returns the file URI, or null if TTS fails.
 *
 * The bridge's /phone/tts/generate endpoint saves audio to a file and returns the path.
 * If that endpoint doesn't exist, falls back to /phone/tts/speak (fire-and-forget, no file).
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
  // Return estimated duration so the bubble can show a progress bar
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
  // ~150 words per minute = 2.5 words/sec
  const words = text.split(/\s+/).length;
  return Math.max(1000, (words / 2.5) * 1000);
}

// ── On-device podcast concat ──────────────────────────────────────────────────

/**
 * Concatenate audio files on-device via the local node API.
 * Falls back to raw byte append if the node endpoint is unavailable.
 *
 * @param audioUris - ordered list of local file URIs to concat
 * @param title - episode title (used in filename)
 * @returns local file URI of the produced MP3, or null on failure
 */
export async function concatPodcastOnDevice(
  audioUris: string[],
  title: string,
  nodeToken: string | null,
): Promise<{ uri: string; durationMs: number } | null> {
  if (audioUris.length === 0) return null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (nodeToken) headers['Authorization'] = `Bearer ${nodeToken}`;

  // Build transcript with audio_uri fields for the node endpoint
  const transcript = audioUris.map((uri, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: '',
    audio_uri: uri,
  }));

  try {
    const resp = await fetch('http://127.0.0.1:9090/podcast/produce-local', {
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
  } catch {
    // Node endpoint unavailable — fall through
  }

  // Fallback: if only one file, just return it directly
  if (audioUris.length === 1) {
    return { uri: audioUris[0], durationMs: 0 };
  }

  // Can't concat without the node — return null
  return null;
}

// ── Format helpers ────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
