/**
 * Ambient augmentations for Web APIs available in Hermes / React Native
 * but absent from the @react-native/typescript-config lib set.
 */

// AbortSignal.timeout() static method — Hermes 0.72+ / modern environments.
// Augments the existing AbortSignal class via namespace merging.
declare namespace AbortSignal {
  function timeout(ms: number): AbortSignal;
}

// SubtleCrypto global — available in Hermes 0.72+.
declare const crypto: {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
};
