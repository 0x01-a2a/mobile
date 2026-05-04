/**
 * useVoiceInput — OS-native speech-to-text for the Chat screen.
 *
 * Uses @react-native-voice/voice which delegates to:
 * - iOS: Apple Speech framework (on-device, free, no API key)
 * - Android: Google SpeechRecognizer (on-device or cloud, free)
 *
 * Returns interim results while speaking and a final transcript on stop.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import Voice, {
  SpeechResultsEvent,
  SpeechErrorEvent,
} from '@react-native-voice/voice';

export interface UseVoiceInputResult {
  /** Whether the microphone is currently listening. */
  listening: boolean;
  /** Interim transcript updated in real-time while speaking. */
  transcript: string;
  /** Start listening. Resolves when speech recognition begins. */
  start: () => Promise<void>;
  /** Stop listening. The final transcript is returned via onResult. */
  stop: () => Promise<void>;
  /** Toggle listening on/off. */
  toggle: () => Promise<void>;
  /** Whether voice input is available on this device. */
  available: boolean;
  /** Last error message, if any. */
  error: string | null;
}

export function useVoiceInput(
  onResult?: (text: string) => void,
): UseVoiceInputResult {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    const onSpeechResults = (e: SpeechResultsEvent) => {
      const text = e.value?.[0] ?? '';
      setTranscript(text);
    };

    const onSpeechPartialResults = (e: SpeechResultsEvent) => {
      const text = e.value?.[0] ?? '';
      setTranscript(text);
    };

    const onSpeechEnd = () => {
      setListening(false);
    };

    const onSpeechError = (e: SpeechErrorEvent) => {
      setListening(false);
      const code = e.error?.code;
      // Code 5 = "no match" (user was silent) — not a real error.
      if (code !== '5') {
        setError(e.error?.message ?? 'Speech recognition error');
      }
    };

    Voice.onSpeechResults = onSpeechResults;
    Voice.onSpeechPartialResults = onSpeechPartialResults;
    Voice.onSpeechEnd = onSpeechEnd;
    Voice.onSpeechError = onSpeechError;

    Voice.isAvailable().then(ok => setAvailable(!!ok)).catch(() => setAvailable(false));

    return () => {
      Voice.destroy().then(Voice.removeAllListeners).catch(() => {});
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setTranscript('');
    try {
      await Voice.start('en-US');
      setListening(true);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to start voice input');
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await Voice.stop();
      setListening(false);
      // Deliver final transcript via callback.
      if (transcript && onResultRef.current) {
        onResultRef.current(transcript);
      }
    } catch {
      setListening(false);
    }
  }, [transcript]);

  const toggle = useCallback(async () => {
    if (listening) {
      await stop();
    } else {
      await start();
    }
  }, [listening, start, stop]);

  return { listening, transcript, start, stop, toggle, available, error };
}
