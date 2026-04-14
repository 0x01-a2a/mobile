/**
 * useLocalLLM — on-device LLM for Private Chat.
 *
 * Downloads and runs Gemma GGUF models via llama.rn (llama.cpp for React
 * Native). No API key required. Inference is fully on-device — no message
 * content ever leaves the phone.
 *
 * Two exports:
 *   useLocalLLM()         React hook that drives download/status UI in Settings
 *   runLocalInference()   Pure async fn called by useZeroclawChat when the
 *                         user has selected the 'local' provider
 */
import { useState, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';
import { initLlama, LlamaContext } from 'llama.rn';

// ── Model catalogue ───────────────────────────────────────────────────────────

export interface LocalModelDef {
  key: string;
  label: string;
  /** Approximate download size in MB. */
  sizeMb: number;
  url: string;
}

export const LOCAL_MODELS: LocalModelDef[] = [
  {
    key: 'gemma-4-1b',
    label: 'Gemma 4 · 1B (680 MB)',
    sizeMb: 680,
    // Q4_K_M quant — best size/quality trade-off for phones < 6 GB RAM
    url: 'https://huggingface.co/google/gemma-4-1b-it-GGUF/resolve/main/gemma-4-1b-it-Q4_K_M.gguf',
  },
  {
    key: 'gemma-4-4b',
    label: 'Gemma 4 · 4B (2.3 GB)',
    sizeMb: 2340,
    url: 'https://huggingface.co/google/gemma-4-4b-it-GGUF/resolve/main/gemma-4-4b-it-Q4_K_M.gguf',
  },
];

export const DEFAULT_LOCAL_MODEL_KEY = 'gemma-4-1b';

// ── Persistence key + directory ───────────────────────────────────────────────

const STORAGE_KEY = 'zerox1:local_llm';
const MODELS_DIR = `${RNFS.DocumentDirectoryPath}/local_models`;

// ── Module-level llama singleton ──────────────────────────────────────────────
// Shared across all hook instances so a loaded model is not reloaded on
// re-renders or screen navigations.

let _ctx: LlamaContext | null = null;
let _ctxModelKey: string | null = null;

// ── Prompt template (Gemma 3/4 chat format) ───────────────────────────────────

function buildPrompt(systemLines: string[], userText: string): string {
  const sysBlock =
    systemLines.length > 0
      ? `<start_of_turn>system\n${systemLines.join('\n')}<end_of_turn>\n`
      : '';
  return (
    `<bos>` +
    sysBlock +
    `<start_of_turn>user\n${userText}<end_of_turn>\n` +
    `<start_of_turn>model\n`
  );
}

// ── Public inference function ─────────────────────────────────────────────────

/**
 * Run a single-turn inference on the locally loaded Gemma model.
 * Throws if the model file has not been downloaded yet.
 */
export async function runLocalInference(
  userText: string,
  systemCtx: string[] = [],
  modelKey: string = DEFAULT_LOCAL_MODEL_KEY,
): Promise<string> {
  // Load (or reload) model if needed.
  if (!_ctx || _ctxModelKey !== modelKey) {
    const modelPath = `${MODELS_DIR}/${modelKey}.gguf`;
    const exists = await RNFS.exists(modelPath);
    if (!exists) {
      throw new Error(
        'Local model not downloaded yet. Go to You → Agent → Brain and tap Download.',
      );
    }

    // Release previous context to free RAM.
    if (_ctx) {
      await _ctx.release().catch(() => {});
      _ctx = null;
    }

    _ctx = await initLlama({
      model: modelPath,
      use_mlock: true,
      n_ctx: 2048,
      n_threads: 4,
      // CPU-only on mobile; GPU layers only on devices with compatible drivers
      n_gpu_layers: 0,
    });
    _ctxModelKey = modelKey;
  }

  const result = await _ctx.completion({
    prompt: buildPrompt(systemCtx, userText),
    n_predict: 512,
    temperature: 0.7,
    top_p: 0.9,
    stop: ['<end_of_turn>', '<eos>', '</s>'],
  });

  return (result.text ?? '').trim();
}

// ── Hook state ────────────────────────────────────────────────────────────────

export type LocalLLMStatus =
  | 'idle'          // nothing happening
  | 'downloading'   // RNFS download in progress
  | 'ready'         // model file on disk, ready to use
  | 'error';        // last operation failed

export interface UseLocalLLMResult {
  status: LocalLLMStatus;
  downloadedModelKey: string | null;
  downloadProgress: number;   // 0–100
  errorMessage: string | null;
  downloadModel: (modelKey?: string) => Promise<void>;
  deleteModel: (modelKey: string) => Promise<void>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useLocalLLM(): UseLocalLLMResult {
  const [status, setStatus] = useState<LocalLLMStatus>('idle');
  const [downloadedModelKey, setDownloadedModelKey] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Hydrate from storage on mount; verify the file actually exists on disk.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved: { downloadedModelKey?: string } = JSON.parse(raw);
        if (saved.downloadedModelKey) {
          const path = `${MODELS_DIR}/${saved.downloadedModelKey}.gguf`;
          const exists = await RNFS.exists(path);
          if (exists) {
            setDownloadedModelKey(saved.downloadedModelKey);
            setStatus('ready');
          } else {
            // File was deleted externally — clear stored key.
            await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({}));
          }
        }
      } catch { /* silently ignore */ }
    })();
  }, []);

  const downloadModel = useCallback(async (modelKey = DEFAULT_LOCAL_MODEL_KEY) => {
    const def = LOCAL_MODELS.find(m => m.key === modelKey);
    if (!def) {
      setErrorMessage(`Unknown model: ${modelKey}`);
      setStatus('error');
      return;
    }

    const destPath = `${MODELS_DIR}/${modelKey}.gguf`;

    // Already downloaded?
    await RNFS.mkdir(MODELS_DIR).catch(() => {});
    if (await RNFS.exists(destPath)) {
      setDownloadedModelKey(modelKey);
      setStatus('ready');
      setDownloadProgress(100);
      return;
    }

    setStatus('downloading');
    setDownloadProgress(0);
    setErrorMessage(null);

    const task = RNFS.downloadFile({
      fromUrl: def.url,
      toFile: destPath,
      progressDivider: 1,
      progress: (res) => {
        if (res.contentLength > 0) {
          setDownloadProgress(Math.round((res.bytesWritten / res.contentLength) * 100));
        }
      },
    });

    try {
      const result = await task.promise;
      if (result.statusCode === 200) {
        setDownloadedModelKey(modelKey);
        setStatus('ready');
        setDownloadProgress(100);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ downloadedModelKey: modelKey }));
      } else {
        await RNFS.unlink(destPath).catch(() => {});
        setStatus('error');
        setErrorMessage(`Download failed (HTTP ${result.statusCode})`);
      }
    } catch (err: unknown) {
      await RNFS.unlink(destPath).catch(() => {});
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Download failed');
    }
  }, []);

  const deleteModel = useCallback(async (modelKey: string) => {
    const destPath = `${MODELS_DIR}/${modelKey}.gguf`;
    try {
      // Release llama context if it's using this model.
      if (_ctxModelKey === modelKey && _ctx) {
        await _ctx.release().catch(() => {});
        _ctx = null;
        _ctxModelKey = null;
      }
      if (await RNFS.exists(destPath)) {
        await RNFS.unlink(destPath);
      }
      const saved = await AsyncStorage.getItem(STORAGE_KEY).then(r =>
        r ? (JSON.parse(r) as { downloadedModelKey?: string }) : {},
      );
      if (saved.downloadedModelKey === modelKey) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ downloadedModelKey: null }));
      }
      if (downloadedModelKey === modelKey) {
        setDownloadedModelKey(null);
        setStatus('idle');
        setDownloadProgress(0);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [downloadedModelKey]);

  return {
    status,
    downloadedModelKey,
    downloadProgress,
    errorMessage,
    downloadModel,
    deleteModel,
  };
}
