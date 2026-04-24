/**
 * phantomDeepLink — Phantom Universal Link (iOS deep link) protocol.
 *
 * Implements the Phantom Mobile SDK deep link spec:
 * https://docs.phantom.com/integrating-phantom/deeplinks-ios-and-android
 *
 * Flow:
 *   connect:              app → Phantom (zerox1://phantom-connect callback)
 *   signAndSendTransaction: app → Phantom (zerox1://phantom-sign callback)
 *
 * Encryption uses NaCl box (X25519 Diffie-Hellman + XSalsa20-Poly1305).
 * Module-level state holds the ephemeral keypair and session between steps.
 */
import 'react-native-get-random-values';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nacl = require('tweetnacl') as typeof import('tweetnacl');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require('bs58') as { encode: (b: Uint8Array) => string; decode: (s: string) => Uint8Array };

const APP_URL      = 'https://0x01.world';
const PHANTOM_BASE = 'https://phantom.app/ul/v1';

// ── Module-level session state ────────────────────────────────────────────────
interface PhantomSession {
  dappKeypair:   typeof nacl.box.keyPair extends () => infer R ? R : never;
  phantomPubKey: Uint8Array;
  session:       string;
}

let dappKeypair:     ReturnType<typeof nacl.box.keyPair> | null = null;
let phantomSession:  PhantomSession | null = null;

// Pending callbacks — set before opening Phantom, consumed by handleIncomingUrl
let pendingConnectCb:      ((publicKey: string | null) => void) | null = null;
let pendingSignCb:         ((sig: string | null) => void) | null = null;
let pendingSignMessageCb:  ((sigBytes: Uint8Array | null) => void) | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseParams(url: string): Record<string, string> {
  const qi = url.indexOf('?');
  if (qi === -1) return {};
  const result: Record<string, string> = {};
  for (const pair of url.slice(qi + 1).split('&')) {
    const ei = pair.indexOf('=');
    if (ei > 0) {
      try {
        result[decodeURIComponent(pair.slice(0, ei))] = decodeURIComponent(pair.slice(ei + 1));
      } catch { /* ignore malformed */ }
    }
  }
  return result;
}

// ── Connect ───────────────────────────────────────────────────────────────────

/**
 * Build the Phantom connect URL. Opens Phantom; on approval Phantom redirects
 * to `zerox1://phantom-connect?phantom_encryption_public_key=...&nonce=...&data=...`
 */
export function buildConnectUrl(redirectSuffix = 'phantom-connect'): string {
  dappKeypair = nacl.box.keyPair();
  const parts = [
    `app_url=${encodeURIComponent(APP_URL)}`,
    `dapp_encryption_public_key=${encodeURIComponent(bs58.encode(dappKeypair.publicKey))}`,
    `redirect_link=${encodeURIComponent(`zerox1://${redirectSuffix}`)}`,
    `cluster=mainnet-beta`,
  ];
  return `${PHANTOM_BASE}/connect?${parts.join('&')}`;
}

function decryptConnectResponse(url: string): string | null {
  if (!dappKeypair) return null;
  const p = parseParams(url);
  if (p.errorCode || !p.phantom_encryption_public_key || !p.nonce || !p.data) return null;
  try {
    const phantomPubKey  = bs58.decode(p.phantom_encryption_public_key);
    const sharedSecret   = nacl.box.before(phantomPubKey, dappKeypair.secretKey);
    const decrypted      = nacl.box.open.after(bs58.decode(p.data), bs58.decode(p.nonce), sharedSecret);
    if (!decrypted) return null;
    const payload = JSON.parse(String.fromCharCode(...decrypted)) as { public_key: string; session: string };
    phantomSession = { dappKeypair: dappKeypair!, phantomPubKey, session: payload.session };
    return payload.public_key;
  } catch {
    return null;
  }
}

// ── Sign message ──────────────────────────────────────────────────────────────

/**
 * Build the Phantom signMessage URL.
 * Requires a prior successful connect (phantomSession must be set).
 * `messageBytes` are the raw bytes to sign (e.g. agent_id as 32 bytes).
 */
export function buildSignMessageUrl(messageBytes: Uint8Array, redirectSuffix = 'phantom-sign-message'): string {
  if (!phantomSession) throw new Error('No Phantom session — call buildConnectUrl first');
  const { dappKeypair: kp, phantomPubKey, session } = phantomSession;
  const nonce      = nacl.randomBytes(24);
  const payloadStr = JSON.stringify({ message: bs58.encode(messageBytes), session, display: 'hex' });
  const encrypted  = nacl.box(Uint8Array.from(payloadStr.split('').map(c => c.charCodeAt(0))), nonce, phantomPubKey, kp.secretKey);
  const parts = [
    `dapp_encryption_public_key=${encodeURIComponent(bs58.encode(kp.publicKey))}`,
    `nonce=${encodeURIComponent(bs58.encode(nonce))}`,
    `redirect_link=${encodeURIComponent(`zerox1://${redirectSuffix}`)}`,
    `payload=${encodeURIComponent(bs58.encode(encrypted))}`,
  ];
  return `${PHANTOM_BASE}/signMessage?${parts.join('&')}`;
}

function decryptSignMessageResponse(url: string): Uint8Array | null {
  if (!phantomSession) return null;
  const p = parseParams(url);
  if (p.errorCode || !p.nonce || !p.data) return null;
  try {
    const { dappKeypair: kp, phantomPubKey } = phantomSession;
    const sharedSecret = nacl.box.before(phantomPubKey, kp.secretKey);
    const decrypted    = nacl.box.open.after(bs58.decode(p.data), bs58.decode(p.nonce), sharedSecret);
    if (!decrypted) return null;
    const { signature } = JSON.parse(String.fromCharCode(...decrypted)) as { signature: string };
    // Phantom returns base58-encoded signature bytes
    return bs58.decode(signature);
  } catch {
    return null;
  }
}

// ── Sign and send ─────────────────────────────────────────────────────────────

/**
 * Build the Phantom signAndSendTransaction URL.
 * Requires a prior successful connect (phantomSession must be set).
 * `serializedTx` is a legacy Transaction serialized with `{ requireAllSignatures: false }`.
 */
export function buildSignAndSendUrl(serializedTx: Uint8Array, redirectSuffix = 'phantom-sign'): string {
  if (!phantomSession) throw new Error('No Phantom session — call buildConnectUrl first');
  const { dappKeypair: kp, phantomPubKey, session } = phantomSession;
  const nonce      = nacl.randomBytes(24);
  const payloadStr = JSON.stringify({ transaction: bs58.encode(serializedTx), session });
  const encrypted  = nacl.box(Uint8Array.from(payloadStr.split('').map(c => c.charCodeAt(0))), nonce, phantomPubKey, kp.secretKey);
  const parts = [
    `dapp_encryption_public_key=${encodeURIComponent(bs58.encode(kp.publicKey))}`,
    `nonce=${encodeURIComponent(bs58.encode(nonce))}`,
    `redirect_link=${encodeURIComponent(`zerox1://${redirectSuffix}`)}`,
    `payload=${encodeURIComponent(bs58.encode(encrypted))}`,
  ];
  return `${PHANTOM_BASE}/signAndSendTransaction?${parts.join('&')}`;
}

function decryptSignResponse(url: string): string | null {
  if (!phantomSession) return null;
  const p = parseParams(url);
  if (p.errorCode || !p.nonce || !p.data) return null;
  try {
    const { dappKeypair: kp, phantomPubKey } = phantomSession;
    const sharedSecret = nacl.box.before(phantomPubKey, kp.secretKey);
    const decrypted    = nacl.box.open.after(bs58.decode(p.data), bs58.decode(p.nonce), sharedSecret);
    if (!decrypted) return null;
    const { signature } = JSON.parse(String.fromCharCode(...decrypted)) as { signature: string };
    return signature;
  } catch {
    return null;
  }
}

/** Returns true if we have a live Phantom session (can call buildSignAndSendUrl). */
export function hasPhantomSession(): boolean {
  return phantomSession !== null;
}

// ── Pending callbacks ─────────────────────────────────────────────────────────

export function setPendingConnectCb(cb: (publicKey: string | null) => void): void {
  pendingConnectCb = cb;
}

export function setPendingSignCb(cb: (sig: string | null) => void): void {
  pendingSignCb = cb;
}

export function setPendingSignMessageCb(cb: (sigBytes: Uint8Array | null) => void): void {
  pendingSignMessageCb = cb;
}

/**
 * Call from a Linking.addEventListener('url') handler.
 * Returns true if the URL was a Phantom callback and was handled.
 */
export function handleIncomingUrl(url: string): boolean {
  if (url.includes('phantom-connect')) {
    const publicKey = decryptConnectResponse(url);
    pendingConnectCb?.(publicKey);
    pendingConnectCb = null;
    return true;
  }
  if (url.includes('phantom-sign-message')) {
    const sigBytes = decryptSignMessageResponse(url);
    pendingSignMessageCb?.(sigBytes);
    pendingSignMessageCb = null;
    return true;
  }
  if (url.includes('phantom-sign')) {
    const sig = decryptSignResponse(url);
    pendingSignCb?.(sig);
    pendingSignCb = null;
    return true;
  }
  return false;
}
