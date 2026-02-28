/**
 * Settings — node config (agent name, relay addr, RPC URL, host node URL)
 * and auto-start toggle.
 */
import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNode } from '../hooks/useNode';
import {
  HostingNode,
  assertValidHostUrl,
  probeRtt,
  registerAsHosted,
  useHostingNodes,
} from '../hooks/useNodeApi';

const C = {
  bg:          '#050505',
  card:        '#0f0f0f',
  border:      '#1a1a1a',
  green:       '#00e676',
  text:        '#ffffff',
  sub:         '#555555',
  amber:       '#ffc107',
  input:       '#111111',
  inputBorder: '#2a2a2a',
};

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.sub}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
    </View>
  );
}

// ── Signal bars ──────────────────────────────────────────────────────────────

function signalLevel(rtt: number | undefined): number {
  if (rtt === undefined) return 0;
  if (rtt <= 50)  return 5;
  if (rtt <= 100) return 4;
  if (rtt <= 200) return 3;
  if (rtt <= 500) return 2;
  return 1;
}

function SignalBars({ rtt }: { rtt: number | undefined }) {
  if (rtt === undefined) {
    return <Text style={s.signalNull}>—</Text>;
  }
  const level = signalLevel(rtt);
  return (
    <View style={s.barsRow}>
      {[1, 2, 3, 4, 5].map(i => (
        <View
          key={i}
          style={[
            s.bar,
            { height: 4 + i * 3, backgroundColor: i <= level ? C.green : C.border },
          ]}
        />
      ))}
    </View>
  );
}

// ── Host Browser Sheet ───────────────────────────────────────────────────────

function HostBrowserSheet({
  visible,
  onClose,
  onConnect,
}: {
  visible:   boolean;
  onClose:   () => void;
  onConnect: (nodeApiUrl: string) => void;
}) {
  const nodes = useHostingNodes();
  const [connecting, setConnecting] = useState<string | null>(null);

  const handleConnect = (node: HostingNode) => {
    Alert.alert(
      'Connect to Host',
      `Connect to "${node.name || node.node_id.slice(0, 12)}"?\nFee: ${node.fee_bps} bps`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Connect',
          onPress: async () => {
            setConnecting(node.node_id);
            try {
              await registerAsHosted(node.api_url);
              onConnect(node.api_url);
              onClose();
            } catch (e: any) {
              Alert.alert('Connection Failed', e?.message ?? 'Unknown error');
            } finally {
              setConnecting(null);
            }
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.sheetOverlay}>
        <View style={s.sheet}>
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>AVAILABLE HOSTS</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={s.sheetClose}>CLOSE</Text>
            </TouchableOpacity>
          </View>

          {nodes.length === 0 ? (
            <Text style={s.sheetEmpty}>no hosts online</Text>
          ) : (
            nodes.map(node => (
              <TouchableOpacity
                key={node.node_id}
                style={s.hostRow}
                onPress={() => handleConnect(node)}
                disabled={connecting === node.node_id}
                activeOpacity={0.7}
              >
                <View style={s.hostInfo}>
                  <Text style={s.hostName}>
                    {node.name || node.node_id.slice(0, 16)}
                  </Text>
                  <Text style={s.hostMeta}>
                    {node.hosted_count} hosted
                  </Text>
                </View>
                <View style={s.hostRight}>
                  <View style={s.feeBadge}>
                    <Text style={s.feeBadgeText}>{node.fee_bps} bps</Text>
                  </View>
                  <SignalBars rtt={node.rtt_ms} />
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export function SettingsScreen() {
  const { config, autoStart, saveConfig, setAutoStart, status, start, stop } = useNode();

  const [agentName,   setAgentName]   = useState(config.agentName   ?? '');
  const [relayAddr,   setRelayAddr]   = useState(config.relayAddr   ?? '');
  const [rpcUrl,      setRpcUrl]      = useState(config.rpcUrl      ?? '');
  const [nodeApiUrl,  setNodeApiUrl]  = useState(config.nodeApiUrl  ?? '');
  const [showBrowser, setShowBrowser] = useState(false);

  // Sync local state if config changes from outside (e.g. on mount)
  useEffect(() => {
    setAgentName(config.agentName   ?? '');
    setRelayAddr(config.relayAddr   ?? '');
    setRpcUrl(config.rpcUrl         ?? '');
    setNodeApiUrl(config.nodeApiUrl ?? '');
  }, [config]);

  const handleSave = async () => {
    const trimmedNodeApiUrl = nodeApiUrl.trim() || undefined;
    if (trimmedNodeApiUrl) {
      try {
        assertValidHostUrl(trimmedNodeApiUrl);
      } catch (e: any) {
        Alert.alert('Invalid Host URL', e?.message ?? 'URL must use HTTPS.');
        return;
      }
    }
    const newConfig = {
      ...config,
      agentName:  agentName.trim()  || undefined,
      relayAddr:  relayAddr.trim()  || undefined,
      rpcUrl:     rpcUrl.trim()     || undefined,
      nodeApiUrl: trimmedNodeApiUrl,
    };
    await saveConfig(newConfig);
    Alert.alert('Saved', 'Config saved. Restart the node to apply changes.');
  };

  const running = status === 'running';

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.heading}>SETTINGS</Text>

        {/* Node config fields */}
        <View style={s.section}>
          <Field
            label="AGENT NAME"
            value={agentName}
            onChange={setAgentName}
            placeholder="my-node"
          />
          <Field
            label="RELAY ADDR"
            value={relayAddr}
            onChange={setRelayAddr}
            placeholder="/ip4/0.0.0.0/tcp/4001/p2p/12D3..."
          />
          <Field
            label="RPC URL"
            value={rpcUrl}
            onChange={setRpcUrl}
            placeholder="https://api.devnet.solana.com"
          />
          {/* Host node URL — leave empty to run local node */}
          <View style={[s.field, { borderBottomWidth: 0 }]}>
            <Text style={s.fieldLabel}>HOST NODE URL</Text>
            <View style={s.hostFieldRow}>
              <TextInput
                style={[s.input, s.hostUrlInput]}
                value={nodeApiUrl}
                onChangeText={setNodeApiUrl}
                placeholder="leave empty to run local node"
                placeholderTextColor={C.sub}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
              <TouchableOpacity
                style={s.browseBtn}
                onPress={() => setShowBrowser(true)}
                activeOpacity={0.8}
              >
                <Text style={s.browseBtnText}>BROWSE</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <TouchableOpacity style={s.saveBtn} onPress={handleSave} activeOpacity={0.8}>
          <Text style={s.saveBtnText}>SAVE CONFIG</Text>
        </TouchableOpacity>

        {/* Auto-start toggle */}
        <View style={s.section}>
          <View style={s.toggleRow}>
            <View>
              <Text style={s.toggleLabel}>AUTO-START</Text>
              <Text style={s.toggleSub}>Start node automatically on device boot</Text>
            </View>
            <Switch
              value={autoStart}
              onValueChange={setAutoStart}
              trackColor={{ false: C.border, true: C.green + '66' }}
              thumbColor={autoStart ? C.green : '#333'}
            />
          </View>
        </View>

        {/* Quick start/stop */}
        <View style={s.section}>
          <TouchableOpacity
            style={[s.nodeBtn, { borderColor: running ? '#ff174440' : C.green + '40' }]}
            onPress={running ? stop : () => start()}
            activeOpacity={0.8}
          >
            <Text style={[s.nodeBtnText, { color: running ? '#ff1744' : C.green }]}>
              {running ? 'STOP NODE' : 'START NODE'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <HostBrowserSheet
        visible={showBrowser}
        onClose={() => setShowBrowser(false)}
        onConnect={(url) => setNodeApiUrl(url)}
      />
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: C.bg },
  content:      { padding: 24 },
  heading:      { fontSize: 11, color: C.sub, letterSpacing: 4, marginBottom: 24 },
  section:      {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    marginBottom: 16,
    overflow: 'hidden',
  },
  field:        { padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  fieldLabel:   { fontSize: 10, color: C.sub, letterSpacing: 2, marginBottom: 8 },
  input:        {
    color: C.text,
    fontFamily: 'monospace',
    fontSize: 14,
    paddingVertical: 0,
  },
  hostFieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hostUrlInput: { flex: 1 },
  browseBtn:    {
    borderWidth: 1,
    borderColor: C.green + '60',
    borderRadius: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  browseBtnText: { fontSize: 9, color: C.green, letterSpacing: 2, fontWeight: '700' },
  saveBtn:      {
    backgroundColor: C.green,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  saveBtnText:  { fontSize: 13, fontWeight: '700', letterSpacing: 3, color: '#000' },
  toggleRow:    {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  toggleLabel:  { fontSize: 11, color: C.text, letterSpacing: 2, fontWeight: '600' },
  toggleSub:    { fontSize: 12, color: C.sub, marginTop: 4 },
  nodeBtn:      {
    margin: 16,
    borderWidth: 1,
    borderRadius: 4,
    paddingVertical: 14,
    alignItems: 'center',
  },
  nodeBtnText:  { fontSize: 13, fontWeight: '700', letterSpacing: 3 },
  // Host browser sheet
  sheetOverlay: {
    flex: 1,
    backgroundColor: '#000000aa',
    justifyContent: 'flex-end',
  },
  sheet:        {
    backgroundColor: C.card,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    maxHeight: '70%',
    paddingBottom: 32,
  },
  sheetHeader:  {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sheetTitle:   { fontSize: 11, color: C.sub, letterSpacing: 3 },
  sheetClose:   { fontSize: 11, color: C.green, letterSpacing: 2 },
  sheetEmpty:   { padding: 24, color: C.sub, fontFamily: 'monospace', textAlign: 'center' },
  hostRow:      {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  hostInfo:     { flex: 1 },
  hostName:     { fontSize: 14, color: C.text, fontFamily: 'monospace', fontWeight: '600' },
  hostMeta:     { fontSize: 11, color: C.sub, marginTop: 2 },
  hostRight:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  feeBadge:     {
    borderWidth: 1,
    borderColor: C.amber + '60',
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  feeBadgeText: { fontSize: 10, color: C.amber, letterSpacing: 1 },
  barsRow:      { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar:          { width: 4, borderRadius: 1 },
  signalNull:   { fontSize: 14, color: C.sub },
});
