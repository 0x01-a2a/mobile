/**
 * Onboarding — first-launch setup for the 01 Pilot agent runtime.
 *
 * Steps:
 *   0 — Welcome
 *   1 — Agent name & avatar
 *   2 — Token choice (optional token launch)
 *   3 — Launch (node start + optional token + key backup)
 */
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLayout } from '../hooks/useLayout';
import { useTranslation } from 'react-i18next';
import React, { useState, useEffect } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_AGENT_ICON_B64, DEFAULT_AGENT_ICON_URI } from '../assets/defaultAgentIcon';
import {
  AgentBrainConfig,
  ALL_CAPABILITIES,
} from '../hooks/useAgentBrain';
import { AGGREGATOR_API } from '../hooks/useNodeApi';
import { useTheme } from '../theme/ThemeContext';

export const ONBOARDING_KEY = 'zerox1:onboarding_done';
const ONBOARDING_STATE_KEY = 'zerox1:onboarding_partial_state';

/**
 * Decodes a base64 string to Uint8Array without relying on global atob()
 * which can be missing or flaky in some React Native environments.
 */
function decodeBase64(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  const len = base64.length;
  let bufferLength = len * 0.75;
  if (base64[len - 1] === '=') {
    bufferLength--;
    if (base64[len - 2] === '=') bufferLength--;
  }

  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const encoded1 = lookup[base64.charCodeAt(i)];
    const encoded2 = lookup[base64.charCodeAt(i + 1)];
    const encoded3 = lookup[base64.charCodeAt(i + 2)];
    const encoded4 = lookup[base64.charCodeAt(i + 3)];

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (p < bufferLength) bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    if (p < bufferLength) bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
  }
  return bytes;
}

export async function markOnboardingDone(): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
  } catch (e) {
    console.warn('markOnboardingDone: failed to persist onboarding flag', e);
  }
}

export async function checkOnboardingDone(): Promise<boolean> {
  return (await AsyncStorage.getItem(ONBOARDING_KEY)) === 'true';
}

import { ThemeColors } from '../theme/ThemeContext';

function useOnboardingStyles(colors: ThemeColors) {
  return React.useMemo(() => makeOnboardingStyles(colors), [colors]);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useStyles(..._args: any[]) {
  const { colors } = useTheme();
  return useOnboardingStyles(colors);
}

// ============================================================================
// Shared layout helpers
// ============================================================================

function StepShell({
  children,
  step,
  total = 4,
}: {
  children: React.ReactNode;
  step: number;
  total?: number;
}) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const { isTablet, contentHPad } = useLayout();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[s.content, isTablet && s.contentTablet, { paddingTop: insets.top + 28 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ paddingHorizontal: contentHPad }}>
          {step > 0 && (
            <View style={s.progressRow}>
              {Array.from({ length: total }, (_, i) => (
                <View key={i} style={[s.pip, i < step && s.pipDone]} />
              ))}
            </View>
          )}
          {children}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Heading({ label }: { label: string }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return <Text style={s.heading}>{label}</Text>;
}

function Sub({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return <Text style={s.sub}>{children}</Text>;
}

function PrimaryBtn({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return (
    <TouchableOpacity
      style={[s.primaryBtn, disabled && s.primaryBtnDisabled, disabled && { opacity: 0.4 }]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <Text style={[s.primaryBtnText, disabled && s.primaryBtnTextDisabled]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function GhostBtn({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return (
    <TouchableOpacity style={s.ghostBtn} onPress={onPress} activeOpacity={0.7} accessibilityLabel={label} accessibilityRole="button">
      <Text style={s.ghostBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function BackBtn({ onPress }: { onPress: () => void }) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const { t } = useTranslation();
  return (
    <TouchableOpacity style={s.backBtn} onPress={onPress} activeOpacity={0.7} accessibilityLabel={t('onboarding.back')} accessibilityRole="button">
      <Text style={s.backBtnText}>{t('onboarding.back')}</Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// Step 0 — Welcome
// ============================================================================

function WelcomeStep({
  phantomWallet,
  onChangePhantomWallet,
  onEnable,
  onSkip,
}: {
  phantomWallet: string;
  onChangePhantomWallet: (v: string) => void;
  onEnable: () => void;
  onSkip: () => void;
}) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  const [riskAgreed, setRiskAgreed] = useState(false);
  const [mwaLoading, setMwaLoading] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const termsOk = agreed && riskAgreed;
  const walletLinked = phantomWallet.trim().length >= 32;

  const handleConnectPhantom = async () => {
    if (!termsOk) {
      Alert.alert('Agreement required', 'Please tick both boxes before connecting.');
      return;
    }
    setMwaLoading(true);

    if (Platform.OS === 'ios') {
      // iOS: Phantom Universal Link deep link protocol (MWA is Android-only)
      const { buildConnectUrl, setPendingConnectCb } = require('../utils/phantomDeepLink');
      setPendingConnectCb((publicKey: string | null) => {
        setMwaLoading(false);
        if (publicKey) {
          onChangePhantomWallet(publicKey);
          onEnable();
        } else {
          Alert.alert('Connection failed', 'Could not connect Phantom. Make sure it is installed and try again.');
        }
      });
      const url = buildConnectUrl('phantom-connect');
      Linking.openURL(url).catch(() => {
        setMwaLoading(false);
        Alert.alert('Could not open Phantom', 'Make sure Phantom is installed on your device.');
      });
      return;
    }

    // Android: MWA protocol
    try {
      const { transact } = require('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
      const { PublicKey } = require('@solana/web3.js');
      await transact(async (wallet: any) => {
        const { accounts } = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: { name: '01 Protocol', uri: 'https://0x01.world', icon: 'https://0x01.world/logo.png' },
        });
        const nonce = new TextEncoder().encode(`01-link-${Date.now()}`);
        await wallet.signMessages({ addresses: [accounts[0].address], payloads: [nonce] });
        const walletB58 = new PublicKey(accounts[0].address).toBase58();
        onChangePhantomWallet(walletB58);
      });
      onEnable();
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('user rejected')) {
        Alert.alert('Connection failed', msg || 'Could not connect Phantom. Make sure it is installed.');
      }
    } finally {
      setMwaLoading(false);
    }
  };

  return (
    <StepShell step={0}>
      <Text style={s.logo}>01</Text>
      <Heading label={t('onboarding.welcomeHeading1')} />
      <Text style={[s.heading, { color: C.green, marginTop: -8 }]}>{t('onboarding.welcomeHeading2')}</Text>
      <Sub>
        01 Pilot is your personal AI podcast companion. Talk to your agent,
        turn conversations into episodes, and share them with the world.
      </Sub>

      <View style={s.featureList}>
        {[
          t('onboarding.feature1Full'),
          t('onboarding.feature2Full'),
          t('onboarding.feature3Full'),
          t('onboarding.feature4Full'),
        ].map((text) => {
          const icon = text.charAt(0);
          const label = text.slice(2);
          return (
            <View key={text} style={s.featureRow}>
              <Text style={s.featureIcon}>{icon}</Text>
              <Text style={s.featureText}>{label}</Text>
            </View>
          );
        })}
      </View>

      <TouchableOpacity
        style={s.termsRow}
        onPress={() => setAgreed(v => !v)}
        activeOpacity={0.7}
      >
        <View style={[s.checkbox, agreed && s.checkboxChecked]}>
          {agreed && <Text style={s.checkmark}>✓</Text>}
        </View>
        <Text style={s.termsText}>
          I agree to the{' '}
          <Text
            style={s.termsLink}
            onPress={() => Linking.openURL('https://www.0x01.world/mobile-terms.html')}
          >
            Terms of Use
          </Text>
          {' '}and{' '}
          <Text
            style={s.termsLink}
            onPress={() => Linking.openURL('https://www.0x01.world/mobile-privacy.html')}
          >
            Privacy Policy
          </Text>
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={s.termsRow}
        onPress={() => setRiskAgreed(v => !v)}
        activeOpacity={0.7}
      >
        <View style={[s.checkbox, riskAgreed && s.checkboxChecked]}>
          {riskAgreed && <Text style={s.checkmark}>✓</Text>}
        </View>
        <Text style={s.termsText}>
          I understand this app controls a non-custodial wallet. Lost keys cannot be recovered. Autonomous agent transactions are irreversible.
        </Text>
      </TouchableOpacity>

      {walletLinked && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, paddingHorizontal: 4 }}>
          <Text style={{ fontSize: 13, color: C.green }}>✓</Text>
          <Text style={{ fontSize: 12, color: C.green, flex: 1 }} numberOfLines={1}>
            {phantomWallet.slice(0, 8)}…{phantomWallet.slice(-6)} linked
          </Text>
          <TouchableOpacity onPress={() => { onChangePhantomWallet(''); setShowPaste(false); }}>
            <Text style={{ fontSize: 11, color: C.dim }}>×</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Connect Phantom — hidden once wallet is already linked */}
      {!walletLinked && (
        <TouchableOpacity
          onPress={handleConnectPhantom}
          disabled={!termsOk || mwaLoading}
          style={{
            backgroundColor: termsOk ? C.blue : C.border,
            borderRadius: 10,
            paddingVertical: 14,
            alignItems: 'center',
            marginBottom: 10,
          }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: termsOk ? C.bg : C.dim }}>
            {mwaLoading ? 'Opening Phantom…' : 'Connect Phantom →'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Paste fallback — collapsed by default */}
      {!walletLinked && (
        <TouchableOpacity onPress={() => setShowPaste(v => !v)} style={{ alignItems: 'center', marginBottom: 8 }}>
          <Text style={{ fontSize: 12, color: C.sub, textDecorationLine: 'underline' }}>
            {showPaste ? 'Hide manual entry' : 'Paste address manually instead'}
          </Text>
        </TouchableOpacity>
      )}

      {showPaste && !walletLinked && (
        <View style={{ marginBottom: 16 }}>
          <TextInput
            style={s.textInput}
            value={phantomWallet}
            onChangeText={onChangePhantomWallet}
            placeholder={t('onboarding.ownerWalletPlaceholder')}
            placeholderTextColor={C.dim}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
          />
          <Text style={{ fontSize: 10, color: C.amber, marginTop: 4 }}>
            Pasting an address does not prove ownership. Connect Phantom for cryptographic proof.
          </Text>
        </View>
      )}

      <PrimaryBtn
        label={walletLinked ? 'Continue →' : t('onboarding.setupAgent')}
        onPress={termsOk ? onEnable : () => Alert.alert('Agreement required', 'Please tick both boxes to continue.')}
        disabled={!termsOk}
      />
      <GhostBtn
        label={t('onboarding.skipForNow')}
        onPress={termsOk ? onSkip : () => Alert.alert('Agreement required', 'Please tick both boxes to continue.')}
      />
    </StepShell>
  );
}

// ============================================================================
// Step 1 — Agent name
// ============================================================================

function NameStep({
  agentName,
  agentAvatar,
  onChangeName,
  onChangeAvatar,
  onBack,
  onNext,
  onSkip,
}: {
  agentName: string;
  agentAvatar: string;
  onChangeName: (v: string) => void;
  onChangeAvatar: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const { t } = useTranslation();
  return (
    <StepShell step={1} total={3}>
      <BackBtn onPress={onBack} />
      <Heading label={t('onboarding.nameYourAgent')} />
      <Sub>{t('onboarding.nameDesc')}</Sub>

      <View style={{ alignItems: 'center', marginBottom: 28 }}>
        <TouchableOpacity
          onPress={async () => {
            const res = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1 });
            if (res?.assets?.[0]?.uri) onChangeAvatar(res.assets[0].uri);
          }}
          style={s.avatarBtn}
        >
          <Image
            source={{ uri: agentAvatar || DEFAULT_AGENT_ICON_URI }}
            style={s.avatarImage}
          />
        </TouchableOpacity>
        <Text style={[s.inputHint, { marginTop: 8 }]}>{t('onboarding.tapToSetPhoto')}</Text>
      </View>

      <Text style={s.inputLabel}>{t('onboarding.agentNameLabel')}</Text>
      <TextInput
        style={s.textInput}
        value={agentName}
        onChangeText={onChangeName}
        placeholder={t('onboarding.agentNamePlaceholder')}
        placeholderTextColor={C.dim}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={32}
      />
      {agentName.trim().length === 1 && (
        <Text style={[s.inputHint, { color: C.amber }]}>
          {t('onboarding.agentNameTooShort')}
        </Text>
      )}
      <Text style={[s.inputHint, { color: C.dim, fontSize: 10 }]}>Min. 2 characters</Text>
      <Text style={s.inputHint}>{t('onboarding.agentNameHint')}</Text>

      <PrimaryBtn
        label={t('onboarding.continueBtn')}
        onPress={() => {
          if (agentName.trim().length < 2) return;
          onNext();
        }}
        disabled={agentName.trim().length < 2}
      />
      <GhostBtn label="Skip, continue without a name" onPress={onSkip} />
    </StepShell>
  );
}

// ============================================================================
// Step 2 — Token choice
// ============================================================================

function TokenChoiceStep({
  agentName,
  onBack,
  onLaunch,
  onSkip,
}: {
  agentName: string;
  onBack: () => void;
  onLaunch: (giftCode?: string, paymentTxid?: string) => void;
  onSkip: () => void;
}) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const name = agentName.trim() || 'your agent';
  const [giftCode, setGiftCode] = useState('');
  const [codeValid, setCodeValid] = useState<boolean | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);
  const [launchInfo, setLaunchInfo] = useState<{
    gated: boolean;
    self_pay_fee_lamports: number;
    fee_wallet: string | null;
    self_pay_available: boolean;
  } | null>(null);
  const [mwaLoading, setMwaLoading] = useState(false);

  useEffect(() => {
    fetch(`${AGGREGATOR_API}/sponsor/launch-info`)
      .then(r => r.json())
      .then(data => setLaunchInfo(data))
      .catch(() => setLaunchInfo({ gated: false, self_pay_fee_lamports: 20_000_000, fee_wallet: null, self_pay_available: false }));
  }, []);

  // Debounce gift code validation
  useEffect(() => {
    if (!giftCode.trim()) { setCodeValid(null); return; }
    const timer = setTimeout(async () => {
      setCodeChecking(true);
      try {
        const res = await fetch(`${AGGREGATOR_API}/sponsor/validate-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: giftCode.trim() }),
        });
        const data = await res.json();
        setCodeValid(data.valid === true);
      } catch {
        setCodeValid(null);
      } finally {
        setCodeChecking(false);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [giftCode]);

  const handlePhantomPay = async () => {
    const feeWallet = launchInfo?.fee_wallet;
    const feeLamports = launchInfo?.self_pay_fee_lamports ?? 20_000_000;
    if (!feeWallet) {
      Alert.alert('Unavailable', 'Self-pay is not configured on this network.');
      return;
    }
    setMwaLoading(true);

    if (Platform.OS === 'ios') {
      // iOS: Phantom Universal Link — connect first, then sign+send
      const { buildConnectUrl, buildSignAndSendUrl, setPendingConnectCb, setPendingSignCb } =
        require('../utils/phantomDeepLink');
      setPendingConnectCb(async (publicKey: string | null) => {
        if (!publicKey) {
          setMwaLoading(false);
          Alert.alert('Connection failed', 'Could not connect Phantom.');
          return;
        }
        try {
          const { Connection, SystemProgram, Transaction, PublicKey } = require('@solana/web3.js');
          const fromPubkey = new PublicKey(publicKey);
          await AsyncStorage.setItem('zerox1:linked_wallet', publicKey).catch(() => {});
          const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
          const { blockhash } = await connection.getLatestBlockhash();
          const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromPubkey }).add(
            SystemProgram.transfer({ fromPubkey, toPubkey: new PublicKey(feeWallet), lamports: feeLamports }),
          );
          const serialized: Uint8Array = tx.serialize({ requireAllSignatures: false });
          setPendingSignCb((sig: string | null) => {
            setMwaLoading(false);
            if (sig) {
              onLaunch(undefined, sig);
            } else {
              Alert.alert('Payment failed', 'Could not complete payment. Please try again.');
            }
          });
          const signUrl = buildSignAndSendUrl(serialized, 'phantom-sign');
          Linking.openURL(signUrl).catch(() => {
            setMwaLoading(false);
            Alert.alert('Could not open Phantom', 'Make sure Phantom is installed on your device.');
          });
        } catch (e: any) {
          setMwaLoading(false);
          Alert.alert('Payment failed', e?.message ?? 'Could not build transaction.');
        }
      });
      const connectUrl = buildConnectUrl('phantom-connect');
      Linking.openURL(connectUrl).catch(() => {
        setMwaLoading(false);
        Alert.alert('Could not open Phantom', 'Make sure Phantom is installed on your device.');
      });
      return;
    }

    // Android: MWA protocol
    try {
      const { transact } = require('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
      const { Connection, SystemProgram, Transaction, PublicKey } = require('@solana/web3.js');
      const txSig: string = await transact(async (wallet: any) => {
        const { accounts } = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: { name: '01 Protocol', uri: 'https://0x01.world', icon: 'https://0x01.world/logo.png' },
        });
        const fromPubkey = new PublicKey(accounts[0].address);
        const walletB58 = fromPubkey.toBase58();
        await AsyncStorage.setItem('zerox1:linked_wallet', walletB58).catch(() => {});
        const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromPubkey }).add(
          SystemProgram.transfer({ fromPubkey, toPubkey: new PublicKey(feeWallet), lamports: feeLamports }),
        );
        const sigs: string[] = await wallet.signAndSendTransactions({ transactions: [tx] });
        return sigs[0];
      });
      if (txSig) onLaunch(undefined, txSig);
    } catch (e: any) {
      Alert.alert('Payment failed', e?.message ?? 'Could not complete Phantom payment. Make sure Phantom is installed.');
    } finally {
      setMwaLoading(false);
    }
  };

  const gated = launchInfo?.gated ?? false;
  const canLaunchFree = !gated || codeValid === true;
  const feeSOL = ((launchInfo?.self_pay_fee_lamports ?? 20_000_000) / 1e9).toFixed(3);
  const selfPayAvailable = !!(launchInfo?.self_pay_available && launchInfo?.fee_wallet);

  const codeStatusColor = codeChecking ? C.dim : codeValid === true ? C.green : codeValid === false ? C.red : C.dim;
  const codeStatusIcon = codeChecking ? '…' : codeValid === true ? '✓' : codeValid === false ? '✗' : '';

  return (
    <StepShell step={2} total={3}>
      <BackBtn onPress={onBack} />
      <Heading label="Launch your agent token?" />
      <Sub>
        {gated
          ? `Enter a gift code to get a sponsored launch for ${name}, or pay a small fee.`
          : `Launching creates a Solana token for ${name} on Bags.fm — free, sponsored by the 01 protocol.`}
      </Sub>

      <View style={{
        backgroundColor: C.green + '10',
        borderWidth: 1,
        borderColor: C.green + '30',
        borderRadius: 10,
        padding: 12,
        marginBottom: 20,
      }}>
        <Text style={{ fontSize: 9, color: C.dim, letterSpacing: 0.5, marginBottom: 6 }}>
          WHAT'S AN AGENT TOKEN?
        </Text>
        <Text style={{ fontSize: 12, color: C.text, lineHeight: 18 }}>
          Listeners discover your podcast, support you by <Text style={{ fontWeight: '600' }}>buying your token</Text>. Trading fees from every purchase go straight to your hot wallet.{gated ? ' Get a gift code from the 01 community.' : ' Free forever, sponsored by 01.'}
        </Text>
      </View>

      {gated && (
        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontSize: 11, color: C.sub, marginBottom: 6, letterSpacing: 0.3 }}>
            GIFT CODE (from Discord / referral)
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: codeValid === true ? C.green : codeValid === false ? C.red : C.inputBorder, borderRadius: 8, paddingHorizontal: 12 }}>
            <TextInput
              style={{ flex: 1, height: 44, fontSize: 14, color: C.text, fontFamily: 'monospace' }}
              placeholder="Enter gift code…"
              placeholderTextColor={C.dim}
              value={giftCode}
              onChangeText={setGiftCode}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {!!codeStatusIcon && (
              <Text style={{ fontSize: 16, color: codeStatusColor, marginLeft: 8 }}>{codeStatusIcon}</Text>
            )}
          </View>
          {codeValid === false && (
            <Text style={{ fontSize: 11, color: C.red, marginTop: 4 }}>Invalid or already used code.</Text>
          )}
        </View>
      )}

      <View style={{
        backgroundColor: C.blue + '10',
        borderWidth: 1,
        borderColor: C.blue + '30',
        borderRadius: 10,
        padding: 12,
        marginBottom: 20,
      }}>
        <Text style={{ fontSize: 9, color: C.dim, letterSpacing: 0.5, marginBottom: 6 }}>
          BACKED BY 01
        </Text>
        <Text style={{ fontSize: 12, color: C.text, lineHeight: 18 }}>
          01 doesn't just host your agent — we back it. We cover launch costs, seed your token with an initial buy, and provide free AI compute on <Text style={{ fontWeight: '600' }}>Gemini 3 Flash</Text> (100k tokens/day free, unlimited with 500,000 $01PL).
        </Text>
      </View>

      <View style={{ gap: 10, marginBottom: 28 }}>
        {[
          { icon: '◈', title: 'We invest from day one', body: '01 makes an initial buy into every agent token at launch — seeding liquidity and taking a position alongside you. Your success is our success.' },
          { icon: '◎', title: gated ? 'Get a code' : 'Zero cost to launch', body: gated ? 'Ask in the 01 Discord or get a referral from an existing agent to receive a sponsored gift code.' : '01 covers all SOL gas fees. You pay nothing to launch.' },
          { icon: '♦', title: 'Earn from your content', body: 'Listeners and fans buy your token to support you. Trading fees from every purchase flow straight to your wallet.' },
        ].map(({ icon, title, body }) => (
          <View key={title} style={s.tokenCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Text style={s.tokenIcon}>{icon}</Text>
              <Text style={s.tokenCardTitle}>{title}</Text>
            </View>
            <Text style={s.tokenCardBody}>{body}</Text>
          </View>
        ))}
      </View>

      {gated && !canLaunchFree && (
        <Text style={{ fontSize: 12, color: C.sub, textAlign: 'center', marginBottom: 10 }}>
          Enter a valid gift code above to launch for free.
        </Text>
      )}
      <PrimaryBtn
        label="Launch my token →"
        onPress={() => canLaunchFree ? onLaunch(gated ? giftCode.trim() : undefined) : undefined}
        disabled={!canLaunchFree}
      />

      {gated && selfPayAvailable && Platform.OS !== 'ios' && (
        <TouchableOpacity
          onPress={handlePhantomPay}
          disabled={mwaLoading}
          style={{
            marginTop: 10,
            borderWidth: 1,
            borderColor: C.blue,
            borderRadius: 8,
            paddingVertical: 12,
            alignItems: 'center',
          }}>
          <Text style={{ fontSize: 14, color: C.blue, fontWeight: '600' }}>
            {mwaLoading ? 'Opening Phantom…' : `Pay with Phantom (~${feeSOL} SOL) →`}
          </Text>
        </TouchableOpacity>
      )}

      <GhostBtn label="Skip, launch later from settings" onPress={onSkip} />
    </StepShell>
  );
}

// ============================================================================
// Root
// ============================================================================

const NODE_CONFIG_KEY = 'zerox1:node_config';

export function OnboardingScreen({
  onDone,
}: {
  onDone: (config: AgentBrainConfig | null) => void;
}) {
  const { colors } = useTheme();
  const { isTablet, isWide, contentHPad, width: screenWidth } = useLayout();
  const s = useStyles(colors, isTablet, isWide, screenWidth);
  const [step, setStep] = useState(0);
  const [phantomWallet, setPhantomWallet] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentAvatar, setAgentAvatar] = useState('');
  const [savedConfig, setSavedConfig] = useState<AgentBrainConfig | null>(null);
  const [launchToken, setLaunchToken] = useState(false);
  const [launchGiftCode, setLaunchGiftCode] = useState('');
  const [launchPaymentTxid, setLaunchPaymentTxid] = useState('');

  // iOS: dispatch Phantom deep link callbacks (zerox1://phantom-connect, zerox1://phantom-sign)
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const { handleIncomingUrl } = require('../utils/phantomDeepLink');
    const sub = Linking.addEventListener('url', ({ url }: { url: string }) => {
      handleIncomingUrl(url);
    });
    // Handle cold-start (app opened FROM Phantom redirect)
    Linking.getInitialURL().then((url: string | null) => {
      if (url) handleIncomingUrl(url);
    }).catch(() => {});
    return () => sub.remove();
  }, []);

  // Load partial onboarding state on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(ONBOARDING_STATE_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          // Never restore to step 3 (LaunchSuccessStep) — savedConfig is not
          // persisted, so restoring to 3 would crash on the null assertion.
          // Clamp to the last data-entry step so the user re-commits cleanly.
          if (typeof saved.step === 'number') setStep(Math.min(saved.step, 2));
          if (saved.agentName) setAgentName(saved.agentName);
          if (saved.agentAvatar) setAgentAvatar(saved.agentAvatar);
        }
      } catch (e) {
        console.warn('Failed to load onboarding state:', e);
      }
    })();
  }, []);

  // Persist partial state on every change
  useEffect(() => {
    const state = { step, agentName, agentAvatar };
    AsyncStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify(state))
      .catch(e => console.warn('Failed to save onboarding state:', e));
  }, [step, agentName, agentAvatar]);

  const handleSkip = async () => {
    await AsyncStorage.removeItem(ONBOARDING_STATE_KEY);
    await markOnboardingDone();
    onDone(null);
  };

  const handleNameNext = async () => {
    try {
      if (agentName.trim() || agentAvatar) {
        const raw = await AsyncStorage.getItem(NODE_CONFIG_KEY);
        let existing: Record<string, unknown> = {};
        try { existing = raw ? JSON.parse(raw) : {}; } catch { /* corrupted */ }
        await AsyncStorage.setItem(
          NODE_CONFIG_KEY,
          JSON.stringify({
            ...existing,
            ...(agentName.trim() ? { agentName: agentName.trim() } : {}),
            ...(agentAvatar ? { agentAvatar } : {}),
          }),
        );
      }
      await AsyncStorage.setItem('zerox1:auto_start', 'true');
      const config: AgentBrainConfig = {
        enabled: true,
        provider: 'default',
        capabilities: ALL_CAPABILITIES,
        minFeeUsdc: 5,
        minReputation: 50,
        autoAccept: false,
        maxActionsPerHour: 100,
        maxCostPerDayCents: 1000,
        apiKeySet: true,  // 'default' provider uses aggregator Gemini proxy — no user key needed
        customBaseUrl: '',
        customModel: '',
      };
      await AsyncStorage.setItem('zerox1:agent_brain', JSON.stringify(config));
      setSavedConfig(config);
      setStep(2);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save config.');
    }
  };

  switch (step) {
    case 0:
      return (
        <WelcomeStep
          phantomWallet={phantomWallet}
          onChangePhantomWallet={setPhantomWallet}
          onEnable={async () => {
            const addr = phantomWallet.trim();
            if (addr) await AsyncStorage.setItem('zerox1:linked_wallet', addr).catch(() => {});
            setStep(1);
          }}
          onSkip={async () => {
            const addr = phantomWallet.trim();
            if (addr) await AsyncStorage.setItem('zerox1:linked_wallet', addr).catch(() => {});
            setStep(1);
          }}
        />
      );
    case 1:
      return (
        <NameStep
          agentName={agentName}
          agentAvatar={agentAvatar}
          onChangeName={setAgentName}
          onChangeAvatar={setAgentAvatar}
          onBack={() => setStep(0)}
          onNext={handleNameNext}
          onSkip={handleNameNext}
        />
      );
    case 2:
      return (
        <TokenChoiceStep
          agentName={agentName}
          onBack={() => setStep(1)}
          onLaunch={(giftCode, paymentTxid) => {
            setLaunchToken(true);
            setLaunchGiftCode(giftCode ?? '');
            setLaunchPaymentTxid(paymentTxid ?? '');
            // Write onboarding_done optimistically before LaunchSuccessStep mounts.
            // If the app is killed mid-launch the node is still running, and the
            // user will land on the main app rather than re-entering onboarding.
            markOnboardingDone().catch(() => {});
            setStep(3);
          }}
          onSkip={() => {
            setLaunchToken(false);
            setLaunchGiftCode('');
            setLaunchPaymentTxid('');
            markOnboardingDone().catch(() => {});
            setStep(3);
          }}
        />
      );
    case 3:
      return (
        <LaunchSuccessStep
          agentName={agentName}
          agentAvatar={agentAvatar}
          config={savedConfig!}
          launchToken={launchToken}
          giftCode={launchGiftCode}
          paymentTxid={launchPaymentTxid}
          onFinish={onDone}
        />
      );
    default:
      return null;
  }
}

// ============================================================================
// Step 3 — Launch Success
// ============================================================================

function deriveSymbol(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return clean.slice(0, 6) || 'AGENT';
}

function LaunchSuccessStep({
  agentName,
  agentAvatar,
  config,
  launchToken,
  giftCode,
  paymentTxid,
  onFinish,
}: {
  agentName: string;
  agentAvatar: string;
  config: AgentBrainConfig;
  launchToken: boolean;
  giftCode?: string;
  paymentTxid?: string;
  onFinish: (config: AgentBrainConfig | null) => void;
}) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'starting' | 'launching' | 'done' | 'error'>('starting');
  const [hotWalletAddress, setHotWalletAddress] = useState<string | null>(null);
  const [secretKeyB58, setSecretKeyB58] = useState<string | null>(null);
  const [tokenMint, setTokenMint] = useState<string | null>(null);
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [tokenLaunchError, setTokenLaunchError] = useState<string | null>(null);

  // Fallback state — shown when launch fails with 402 (wrong/missing gift code)
  const [fallbackNeeded, setFallbackNeeded] = useState(false);
  const [fallbackFee, setFallbackFee] = useState<{ lamports: number; wallet: string | null }>({ lamports: 20_000_000, wallet: null });
  const [socialShared, setSocialShared] = useState(false);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  // Stored so fallback can reuse them when retrying
  const agentIdHexRef = React.useRef<string | null>(null);
  const launchBodyBaseRef = React.useRef<Record<string, unknown>>({});

  // Phase indicators for the launch sequence
  type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'error';
  const [phaseStatuses, setPhaseStatuses] = useState<PhaseStatus[]>(['in-progress', 'pending', 'pending']);
  const phaseLabels = ['Starting your agent…', 'Agent identity ready', 'Launching token on Bags.fm…'];

  const runLaunchSequence = async (cancelled: () => boolean) => {
    try {
      const { NodeModule } = require('../native/NodeModule');
      const raw = await AsyncStorage.getItem(NODE_CONFIG_KEY);
      const nodeConfig = raw ? JSON.parse(raw) : {};

      let fullConfig = nodeConfig;
      try {
        const brainRaw = await AsyncStorage.getItem('zerox1:agent_brain');
        const brain = brainRaw ? JSON.parse(brainRaw) : null;
        if (brain?.enabled && brain?.apiKeySet) {
          fullConfig = {
            ...nodeConfig,
            agentBrainEnabled: true,
            llmProvider: brain.provider ?? 'default',
            llmModel: brain.customModel ?? '',
            llmBaseUrl: brain.customBaseUrl ?? '',
            capabilities: JSON.stringify(brain.capabilities ?? []),
            minFeeUsdc: brain.minFeeUsdc ?? 5,
            minReputation: brain.minReputation ?? 50,
            autoAccept: brain.autoAccept ?? true,
          };
        }
      } catch { /* proceed without brain */ }

      await NodeModule.startNode(fullConfig);
      if (cancelled()) return;

      let auth: { nodeApiToken?: string } = {};
      try { auth = await NodeModule.getLocalAuthConfig(); } catch { /* ok */ }
      const apiToken: string = auth?.nodeApiToken ?? '';
      const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiToken) authHeaders.Authorization = `Bearer ${apiToken}`;

      // Phase 0: wait for REST API
      let walletAddr: string | null = null;
      let agentIdHex: string | null = null;
      let apiReady = false;
      for (let i = 0; i < 30; i++) {
        await new Promise<void>(r => setTimeout(r, 1000));
        if (cancelled()) return;
        try {
          const res = await fetch('http://127.0.0.1:9090/identity', { headers: authHeaders });
          if (res.ok) {
            apiReady = true;
            const data: { agent_id: string } = await res.json();
            agentIdHex = data.agent_id;
            const hexId: string = data.agent_id ?? '';
            if (hexId.length === 64 && /^[0-9a-fA-F]{64}$/.test(hexId)) {
              const { PublicKey } = require('@solana/web3.js');
              const bytes = Uint8Array.from(
                (hexId.match(/.{1,2}/g)!).map((b: string) => parseInt(b, 16)),
              );
              try { walletAddr = new PublicKey(bytes).toBase58(); } catch { /* invalid */ }
            }
            if (!cancelled()) setHotWalletAddress(walletAddr);
            break;
          }
        } catch { /* not ready */ }
      }
      if (cancelled()) return;

      if (!apiReady) {
        setPhaseStatuses(['error', 'pending', 'pending']);
        setErrorMsg('Node REST API did not respond within 30 seconds.');
        setPhase('error');
        return;
      }

      // Phase 0 done, Phase 1 in-progress
      setPhaseStatuses(['done', 'in-progress', 'pending']);

      try {
        const keyRes = await fetch('http://127.0.0.1:9090/identity/export-key', { headers: authHeaders });
        if (keyRes.ok) {
          const keyData: { secret_key_b58: string } = await keyRes.json();
          if (!cancelled()) setSecretKeyB58(keyData.secret_key_b58);
        }
      } catch { /* non-fatal */ }

      if (cancelled()) return;

      // Register hot wallet ownership with the aggregator (silent, non-blocking).
      // The hot wallet IS the agent identity key — sign the agent_id bytes with
      // that same key so the aggregator can verify ownership without a round-trip.
      if (agentIdHex && walletAddr) {
        try {
          const signRes = await fetch('http://127.0.0.1:9090/identity/sign', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ bytes_hex: agentIdHex }),
          });
          if (signRes.ok) {
            const { signature_hex }: { signature_hex: string } = await signRes.json();
            // Convert hex signature to base64 (aggregator expects base64).
            const sigBytes = new Uint8Array((signature_hex.match(/.{1,2}/g)!).map((b: string) => parseInt(b, 16)));
            const sigB64 = btoa(String.fromCharCode(...sigBytes));
            await fetch(`${AGGREGATOR_API}/wallets/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agent_id: agentIdHex,
                wallet_address: walletAddr,
                signature: sigB64,
              }),
            }).catch(() => { /* non-fatal — can retry later */ });
          }
        } catch { /* non-fatal */ }
      }

      if (cancelled()) return;

      // Phase 1 done
      setPhaseStatuses(prev => {
        const next = [...prev];
        next[1] = 'done';
        next[2] = launchToken ? 'in-progress' : 'done';
        return next;
      });

      // Phase 2: token launch
      if (launchToken) {
        setPhase('launching');
        const symbol = deriveSymbol(agentName || 'Agent');
        const displayName = agentName.trim() || 'My Agent';
        const launchBody: Record<string, unknown> = {
          agent_id_hex: agentIdHex ?? '',
          name: displayName,
          symbol,
          description: `${displayName} is an AI-powered podcast companion on 01 Pilot. Listen at 0x01.world.`,
        };
        if (agentAvatar?.startsWith('data:')) {
          launchBody.image_b64 = agentAvatar.split(',')[1] ?? '';
        } else {
          launchBody.image_b64 = DEFAULT_AGENT_ICON_B64;
        }
        if (giftCode) launchBody.gift_code = giftCode;
        if (paymentTxid) launchBody.payment_txid = paymentTxid;
        // Store for fallback retries
        agentIdHexRef.current = agentIdHex;
        launchBodyBaseRef.current = { ...launchBody };

        let tokenSuccess = false;
        try {
          const controller = new AbortController();
          const launchTimeout = setTimeout(() => controller.abort(), 60_000);
          let launchRes: Response;
          try {
            launchRes = await fetch(`${AGGREGATOR_API}/sponsor/launch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(launchBody),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(launchTimeout);
          }

          if (launchRes.ok) {
            const lj: { token_mint?: string } = await launchRes.json().catch(() => ({}));
            const mint = lj.token_mint ?? null;
            if (!cancelled() && mint) {
              setTokenMint(mint);
              const brainRaw = await AsyncStorage.getItem('zerox1:agent_brain');
              const brain = brainRaw ? JSON.parse(brainRaw) : {};
              await AsyncStorage.setItem('zerox1:agent_brain', JSON.stringify({ ...brain, tokenAddress: mint }));
              tokenSuccess = true;
            }
          } else if (launchRes.status === 409) {
            await new Promise<void>(r => setTimeout(r, 8_000));
            if (!cancelled()) {
              const retryController = new AbortController();
              const retryTimeout = setTimeout(() => retryController.abort(), 60_000);
              try {
                const retryRes = await fetch(`${AGGREGATOR_API}/sponsor/launch`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(launchBody),
                  signal: retryController.signal,
                });
                if (retryRes.ok) {
                  const lj: { token_mint?: string } = await retryRes.json().catch(() => ({}));
                  const mint = lj.token_mint ?? null;
                  if (!cancelled() && mint) {
                    setTokenMint(mint);
                    const brainRaw = await AsyncStorage.getItem('zerox1:agent_brain');
                    const brain = brainRaw ? JSON.parse(brainRaw) : {};
                    await AsyncStorage.setItem('zerox1:agent_brain', JSON.stringify({ ...brain, tokenAddress: mint }));
                    tokenSuccess = true;
                  }
                } else {
                  const errText = await retryRes.text().catch(() => '');
                  if (!cancelled()) setTokenLaunchError(errText || `HTTP ${retryRes.status}`);
                }
              } finally {
                clearTimeout(retryTimeout);
              }
            }
          } else if (launchRes.status === 402) {
            const body = await launchRes.json().catch(() => ({}));
            if (!cancelled()) {
              setFallbackFee({
                lamports: body.self_pay_fee_lamports ?? 20_000_000,
                wallet: body.self_pay_fee_wallet ?? null,
              });
              setFallbackNeeded(true);
              setPhaseStatuses(prev => { const n = [...prev]; n[2] = 'error'; return n; });
            }
          } else {
            const errText = await launchRes.text().catch(() => '');
            if (!cancelled()) setTokenLaunchError(errText || `HTTP ${launchRes.status}`);
          }
        } catch (e: any) {
          if (!cancelled()) setTokenLaunchError(e?.message ?? 'Unknown error');
        }

        setPhaseStatuses(prev => {
          const next = [...prev];
          next[2] = tokenSuccess ? 'done' : 'error';
          return next;
        });
      }

      if (!cancelled()) setPhase('done');
    } catch (e: any) {
      if (!cancelled()) {
        setErrorMsg(e?.message ?? 'Failed to start node.');
        setPhaseStatuses(['error', 'pending', 'pending']);
        setPhase('error');
      }
    }
  };

  useEffect(() => {
    let isCancelled = false;
    const cancelled = () => isCancelled;
    runLaunchSequence(cancelled);
    return () => { isCancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetry = () => {
    setPhase('starting');
    setPhaseStatuses(['in-progress', 'pending', 'pending']);
    setErrorMsg(null);
    setTokenLaunchError(null);
    setTokenMint(null);
    setHotWalletAddress(null);
    setSecretKeyB58(null);
    let isCancelled = false;
    runLaunchSequence(() => isCancelled);
  };

  const retryLaunch = async (proof: { type: 'social' } | { type: 'pay'; txid: string }) => {
    setFallbackLoading(true);
    try {
      const body: Record<string, unknown> = { ...launchBodyBaseRef.current };
      if (proof.type === 'social') {
        body.social_proof = true;
      } else {
        body.payment_txid = proof.txid;
      }
      const controller = new AbortController();
      const launchTimeout = setTimeout(() => controller.abort(), 60_000);
      let res: Response;
      try {
        res = await fetch(`${AGGREGATOR_API}/sponsor/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(launchTimeout);
      }
      if (res.ok) {
        const lj: { token_mint?: string } = await res.json().catch(() => ({}));
        const mint = lj.token_mint ?? null;
        if (mint) {
          setTokenMint(mint);
          const brainRaw = await AsyncStorage.getItem('zerox1:agent_brain');
          const brain = brainRaw ? JSON.parse(brainRaw) : {};
          await AsyncStorage.setItem('zerox1:agent_brain', JSON.stringify({ ...brain, tokenAddress: mint }));
          setFallbackNeeded(false);
          setPhaseStatuses(prev => { const n = [...prev]; n[2] = 'done'; return n; });
        }
      } else {
        const errText = await res.text().catch(() => '');
        Alert.alert('Launch failed', errText || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      Alert.alert('Launch failed', e?.message ?? 'Unknown error');
    } finally {
      setFallbackLoading(false);
    }
  };

  const handlePhantomPayFallback = async () => {
    const { wallet, lamports } = fallbackFee;
    if (!wallet) {
      Alert.alert('Unavailable', 'Self-pay is not configured on this server.');
      return;
    }
    setFallbackLoading(true);

    if (Platform.OS === 'ios') {
      // iOS: Phantom Universal Link — connect first, then sign+send
      const { buildConnectUrl, buildSignAndSendUrl, setPendingConnectCb, setPendingSignCb } =
        require('../utils/phantomDeepLink');
      setPendingConnectCb(async (publicKey: string | null) => {
        if (!publicKey) {
          setFallbackLoading(false);
          Alert.alert('Connection failed', 'Could not connect Phantom.');
          return;
        }
        try {
          const { Connection, SystemProgram, Transaction, PublicKey } = require('@solana/web3.js');
          const fromPubkey = new PublicKey(publicKey);
          const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
          const { blockhash } = await connection.getLatestBlockhash();
          const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromPubkey }).add(
            SystemProgram.transfer({ fromPubkey, toPubkey: new PublicKey(wallet), lamports }),
          );
          const serialized: Uint8Array = tx.serialize({ requireAllSignatures: false });
          setPendingSignCb(async (sig: string | null) => {
            setFallbackLoading(false);
            if (sig) {
              await retryLaunch({ type: 'pay', txid: sig });
            } else {
              Alert.alert('Payment failed', 'Could not complete payment. Please try again.');
            }
          });
          const signUrl = buildSignAndSendUrl(serialized, 'phantom-sign');
          Linking.openURL(signUrl).catch(() => {
            setFallbackLoading(false);
            Alert.alert('Could not open Phantom', 'Make sure Phantom is installed on your device.');
          });
        } catch (e: any) {
          setFallbackLoading(false);
          Alert.alert('Payment failed', e?.message ?? 'Could not build transaction.');
        }
      });
      const connectUrl = buildConnectUrl('phantom-connect');
      Linking.openURL(connectUrl).catch(() => {
        setFallbackLoading(false);
        Alert.alert('Could not open Phantom', 'Make sure Phantom is installed on your device.');
      });
      return;
    }

    // Android: MWA protocol
    try {
      const { transact } = require('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
      const { Connection, SystemProgram, Transaction, PublicKey } = require('@solana/web3.js');
      const txSig: string = await transact(async (mwaWallet: any) => {
        const { accounts } = await mwaWallet.authorize({
          cluster: 'mainnet-beta',
          identity: { name: '01 Protocol', uri: 'https://0x01.world', icon: 'https://0x01.world/logo.png' },
        });
        const fromPubkey = new PublicKey(accounts[0].address);
        const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromPubkey }).add(
          SystemProgram.transfer({ fromPubkey, toPubkey: new PublicKey(wallet), lamports }),
        );
        const sigs: string[] = await mwaWallet.signAndSendTransactions({ transactions: [tx] });
        return sigs[0];
      });
      if (txSig) await retryLaunch({ type: 'pay', txid: txSig });
    } catch (e: any) {
      Alert.alert('Payment failed', e?.message ?? 'Could not complete payment. Make sure Phantom is installed.');
    } finally {
      setFallbackLoading(false);
    }
  };

  const handleCopyKey = () => {
    if (!secretKeyB58) return;
    Clipboard.setString(secretKeyB58);
    setKeyCopied(true);
  };

  const handleDone = async () => {
    await AsyncStorage.removeItem(ONBOARDING_STATE_KEY);
    await markOnboardingDone();
    onFinish(config);
  };

  const isLoading = phase === 'starting' || phase === 'launching';

  return (
    <StepShell step={0} total={3}>
      <Heading label="Agent launched" />

      {isLoading && (
        <Sub>
          {phase === 'starting' ? 'Starting node…' : 'Launching your token on Bags.fm…'}
        </Sub>
      )}

      {/* Phase step indicators */}
      <View style={[s.infoCard, { marginBottom: 16 }]}>
        {phaseLabels.map((label, idx) => {
          const status = phaseStatuses[idx];
          // Only show Token launched row when launchToken is true
          if (idx === 2 && !launchToken) return null;
          return (
            <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: idx < phaseLabels.length - 1 ? 10 : 0 }}>
              {status === 'done' && (
                <Text style={{ fontSize: 14, color: C.green, width: 18 }}>✓</Text>
              )}
              {status === 'in-progress' && (
                <ActivityIndicator size="small" color={C.green} style={{ width: 18 }} />
              )}
              {status === 'pending' && (
                <Text style={{ fontSize: 18, color: C.dim, width: 18, lineHeight: 20 }}>•</Text>
              )}
              {status === 'error' && (
                <Text style={{ fontSize: 14, color: C.red, width: 18 }}>✗</Text>
              )}
              <Text style={{ fontSize: 13, color: status === 'done' ? C.green : status === 'error' ? C.red : status === 'in-progress' ? C.text : C.dim, flex: 1 }}>
                {label}
              </Text>
            </View>
          );
        })}
      </View>

      {phase === 'error' && (
        <View style={[s.infoCard, { borderColor: C.red + '30', backgroundColor: C.red + '08' }]}>
          <Text style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{errorMsg}</Text>
          <TouchableOpacity
            style={[s.copyBtn, { borderColor: C.red }]}
            onPress={handleRetry}
            activeOpacity={0.7}
          >
            <Text style={[s.copyBtnText, { color: C.red }]}>{t('onboarding.retry')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Token result — only shown if user chose to launch */}
      {launchToken && (
        tokenMint ? (
          <View style={[s.infoCard, { borderColor: C.green + '30', backgroundColor: C.green + '10' }]}>
            <Text style={s.infoCardLabel}>{t('onboarding.yourAgentToken')}</Text>
            <Text style={s.infoCardHint}>
              Live on Bags.fm. Fans buy it to support you — trading fees go to your hot wallet.
            </Text>
            <Text style={s.monoText} selectable>{tokenMint}</Text>
            <TouchableOpacity
              style={s.copyBtn}
              onPress={() => Share.share({ message: tokenMint })}
              activeOpacity={0.7}
            >
              <Text style={s.copyBtnText}>{t('onboarding.copyMint')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.copyBtn, { borderColor: C.blue, marginTop: 8 }]}
              onPress={() => {
                const agentName = (launchBodyBaseRef.current.name as string) ?? 'my agent';
                Linking.openURL(
                  `https://twitter.com/intent/tweet?text=${encodeURIComponent(
                    `Just launched my AI podcast companion on 01 Pilot — support my content by buying my token.\n\nToken: ${tokenMint}\n\n@01pilot_kt\n#01Pilot #AIPodcast`,
                  )}`,
                );
              }}
              activeOpacity={0.7}
            >
              <Text style={[s.copyBtnText, { color: C.blue }]}>Share on X →</Text>
            </TouchableOpacity>
          </View>
        ) : phase === 'done' && !fallbackNeeded && (
          <View style={s.infoCard}>
            <Text style={s.infoCardLabel}>TOKEN LAUNCH</Text>
            <Text style={s.infoCardHint}>
              {tokenLaunchError
                ? 'Token launch failed — you can retry later from Settings.'
                : 'Token launch pending. You can launch from Settings anytime.'}
            </Text>
            {tokenLaunchError && (
              <Text style={[s.infoCardHint, { color: C.red, marginTop: 4 }]}>
                {tokenLaunchError}
              </Text>
            )}
          </View>
        )
      )}

      {/* Fallback: 402 — wrong/missing gift code */}
      {fallbackNeeded && !tokenMint && (
        <View style={[s.infoCard, { borderColor: C.blue + '30', backgroundColor: C.blue + '08', marginTop: 10 }]}>
          <Text style={[s.infoCardLabel, { color: C.blue }]}>FREE LAUNCH LOCKED</Text>
          <Text style={s.infoCardHint}>
            Sponsored launches require a gift code — ask in the 01 Discord or get a referral. No code yet? Share on X to unlock access, or pay a small SOL fee.
          </Text>

          {/* Social share option */}
          <Text style={[s.infoCardHint, { marginTop: 10, color: C.sub, fontStyle: 'italic' }]}>
            Share the post below, then tap "I've shared" to unlock your free launch.
          </Text>
          <TouchableOpacity
            style={{
              marginTop: 8,
              borderWidth: 1,
              borderColor: C.blue,
              borderRadius: 8,
              paddingVertical: 11,
              alignItems: 'center',
            }}
            disabled={fallbackLoading}
            onPress={async () => {
              const agentName = (launchBodyBaseRef.current.name as string) ?? 'my agent';
              const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
                `Setting up my AI podcast companion on 01 Pilot — talk, create, share.\n\nGet early access @01pilot_kt\n#01Pilot #AIPodcast`,
              )}`;
              await Linking.openURL(twitterUrl);
              setSocialShared(true);
            }}
          >
            <Text style={{ fontSize: 14, color: C.blue, fontWeight: '600' }}>
              Share on X (Twitter) →
            </Text>
          </TouchableOpacity>

          {socialShared && (
            <TouchableOpacity
              style={{
                marginTop: 8,
                borderWidth: 1,
                borderColor: C.green,
                borderRadius: 8,
                paddingVertical: 11,
                alignItems: 'center',
              }}
              disabled={fallbackLoading}
              onPress={() => retryLaunch({ type: 'social' })}
            >
              {fallbackLoading ? (
                <ActivityIndicator size="small" color={C.green} />
              ) : (
                <Text style={{ fontSize: 14, color: C.green, fontWeight: '600' }}>
                  I've shared — launch my token →
                </Text>
              )}
            </TouchableOpacity>
          )}

          {/* Self-pay option */}
          {fallbackFee.wallet && (
            <TouchableOpacity
              style={{
                marginTop: 8,
                borderWidth: 1,
                borderColor: C.blue,
                borderRadius: 8,
                paddingVertical: 11,
                alignItems: 'center',
              }}
              disabled={fallbackLoading}
              onPress={handlePhantomPayFallback}
            >
              {fallbackLoading ? (
                <ActivityIndicator size="small" color={C.blue} />
              ) : (
                <Text style={{ fontSize: 14, color: C.blue, fontWeight: '600' }}>
                  {`Pay with Phantom (~${(fallbackFee.lamports / 1e9).toFixed(3)} SOL) →`}
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Hot wallet & secret key */}
      <View style={[s.infoCard, { borderColor: C.amber + '30', backgroundColor: C.amber + '08', marginTop: 10 }]}>
        <Text style={[s.infoCardLabel, { color: C.amber }]}>{t('onboarding.hotWalletWarning')}</Text>
        <Text style={s.infoCardHint}>
          Your agent's identity and earning wallet. Back up the secret key before closing
          this screen — it cannot be recovered if lost.
        </Text>

        {hotWalletAddress && (
          <>
            <Text style={[s.inputLabel, { marginTop: 12 }]}>{t('onboarding.addressLabel')}</Text>
            <Text style={s.monoText} selectable>{hotWalletAddress}</Text>
          </>
        )}

        <Text style={[s.inputLabel, { marginTop: 12, color: C.amber }]}>{t('onboarding.secretKeyLabel')}</Text>

        {secretKeyB58 ? (
          <>
            {secretRevealed ? (
              <>
                <Text style={[s.infoCardHint, { color: C.amber, marginBottom: 6 }]}>
                  Do not screenshot. Use the copy button below.
                </Text>
                <Text style={[s.monoText, { fontSize: 10, lineHeight: 16 }]}>{secretKeyB58}</Text>
              </>
            ) : (
              <TouchableOpacity
                style={[s.copyBtn, { borderColor: C.amber }]}
                onPress={() => setSecretRevealed(true)}
                activeOpacity={0.7}
              >
                <Text style={[s.copyBtnText, { color: C.amber }]}>{t('onboarding.tapToReveal')}</Text>
              </TouchableOpacity>
            )}
            {secretRevealed && (
              <TouchableOpacity
                style={[s.copyBtn, { borderColor: keyCopied ? C.green : C.amber, marginTop: 8 }]}
                onPress={handleCopyKey}
                activeOpacity={0.7}
              >
                <Text style={[s.copyBtnText, { color: keyCopied ? C.green : C.amber }]}>
                  {keyCopied ? 'Copied ✓' : 'Copy secret key'}
                </Text>
              </TouchableOpacity>
            )}
          </>
        ) : (
          <Text style={s.infoCardHint}>
            {isLoading ? 'Loading…' : 'Key unavailable — export from Settings after setup.'}
          </Text>
        )}
      </View>

      {/* Key must be revealed (and ideally copied) before proceeding — prevents accidental loss */}
      {secretKeyB58 && !keyCopied && phase === 'done' && (
        <Text style={{ fontSize: 12, color: C.amber, textAlign: 'center', marginBottom: 10 }}>
          Copy your secret key before continuing — it cannot be recovered if lost.
        </Text>
      )}
      <PrimaryBtn
        label="Start creating →"
        onPress={handleDone}
        disabled={isLoading || (!!secretKeyB58 && !keyCopied && phase === 'done')}
      />
    </StepShell>
  );
}

// ============================================================================
// Styles
// ============================================================================

function makeOnboardingStyles(C: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    content: { padding: 28, paddingBottom: 48 },
    contentTablet: { padding: 48, paddingTop: 64, paddingBottom: 64 },

    progressRow: { flexDirection: 'row', gap: 6, marginBottom: 36 },
    pip: { height: 3, flex: 1, backgroundColor: C.border, borderRadius: 2 },
    pipDone: { backgroundColor: C.green },

    logo: {
      fontSize: 28,
      fontWeight: '800',
      color: C.green,
      letterSpacing: -1,
      marginBottom: 20,
    },
    heading: {
      fontSize: 26,
      fontWeight: '700',
      color: C.text,
      letterSpacing: -0.5,
      marginBottom: 12,
    },
    sub: {
      fontSize: 14,
      color: C.sub,
      lineHeight: 21,
      marginBottom: 28,
    },

    // Feature list (step 0)
    featureList: { marginBottom: 28, gap: 10 },
    featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    featureIcon: { fontSize: 14, color: C.green, lineHeight: 20, width: 16 },
    featureText: { fontSize: 14, color: C.text, lineHeight: 20, flex: 1 },

    // Terms agreement
    termsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 16, marginBottom: 4 },
    checkbox: {
      width: 18, height: 18, borderRadius: 4, borderWidth: 1,
      borderColor: C.border, alignItems: 'center', justifyContent: 'center', marginTop: 1,
    },
    checkboxChecked: { backgroundColor: C.green, borderColor: C.green },
    checkmark: { fontSize: 11, color: C.bg, fontWeight: '700' },
    termsText: { fontSize: 12, color: C.sub, lineHeight: 18, flex: 1 },
    termsLink: { color: C.green, textDecorationLine: 'underline' },

    // Inputs
    inputLabel: { fontSize: 10, color: C.dim, letterSpacing: 0.5, marginBottom: 6 },
    textInput: {
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      color: C.text,
      marginBottom: 8,
    },
    inputHint: { fontSize: 11, color: C.dim, marginBottom: 20, lineHeight: 16 },

    // Avatar picker (step 1)
    avatarBtn: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: C.green + '10',
      borderWidth: 2,
      borderColor: C.green + '30',
      overflow: 'hidden',
    },
    avatarImage: { width: 80, height: 80 },

    // Provider grid (step 2)
    providerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
    providerCard: {
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 10,
      padding: 14,
    },
    providerCardActive: { borderColor: C.green, backgroundColor: C.green + '10' },
    providerLabel: { fontSize: 14, fontWeight: '600', color: C.sub, marginBottom: 2 },
    providerLabelActive: { color: C.green },
    providerModel: { fontSize: 10, color: C.dim },

    // Token choice cards (step 5)
    tokenCard: {
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 12,
      padding: 14,
    },
    tokenIcon: { fontSize: 14, color: C.green },
    tokenCardTitle: { fontSize: 13, fontWeight: '600', color: C.text },
    tokenCardBody: { fontSize: 12, color: C.sub, lineHeight: 18 },

    // Info cards (step 6)
    infoCard: {
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 12,
      padding: 14,
      marginBottom: 14,
    },
    infoCardLabel: { fontSize: 10, color: C.green, letterSpacing: 0.5, marginBottom: 6 },
    infoCardHint: { fontSize: 12, color: C.sub, lineHeight: 17 },
    monoText: {
      fontSize: 12,
      color: C.text,
      fontFamily: 'monospace',
      lineHeight: 18,
      marginTop: 4,
      marginBottom: 8,
    },
    copyBtn: {
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderColor: C.green,
      borderRadius: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginTop: 4,
      minWidth: 44,
      minHeight: 44,
      justifyContent: 'center',
    },
    copyBtnText: { fontSize: 11, color: C.green, fontWeight: '600' },

    // Buttons
    primaryBtn: {
      backgroundColor: C.text,
      borderRadius: 12,
      paddingVertical: 15,
      alignItems: 'center',
      marginBottom: 12,
    },
    primaryBtnDisabled: { backgroundColor: C.border },
    primaryBtnText: { fontSize: 14, fontWeight: '700', color: C.bg, letterSpacing: 0.2 },
    primaryBtnTextDisabled: { color: C.dim },
    ghostBtn: {
      alignItems: 'center',
      paddingVertical: 12,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 12,
      marginBottom: 8,
    },
    ghostBtnText: { fontSize: 13, color: C.sub },
    backBtn: { marginBottom: 20 },
    backBtnText: { fontSize: 12, color: C.dim },
  });
}
