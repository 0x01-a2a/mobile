/**
 * Settings — node config (agent name, relay addr, RPC URL) and auto-start toggle.
 */
import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
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

const C = {
  bg:       '#050505',
  card:     '#0f0f0f',
  border:   '#1a1a1a',
  green:    '#00e676',
  text:     '#ffffff',
  sub:      '#555555',
  input:    '#111111',
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

export function SettingsScreen() {
  const { config, autoStart, saveConfig, setAutoStart, status, start, stop } = useNode();

  const [agentName,  setAgentName]  = useState(config.agentName  ?? '');
  const [relayAddr,  setRelayAddr]  = useState(config.relayAddr  ?? '');
  const [rpcUrl,     setRpcUrl]     = useState(config.rpcUrl     ?? '');

  // Sync local state if config changes from outside (e.g. on mount)
  useEffect(() => {
    setAgentName(config.agentName  ?? '');
    setRelayAddr(config.relayAddr  ?? '');
    setRpcUrl(config.rpcUrl        ?? '');
  }, [config]);

  const handleSave = async () => {
    const newConfig = {
      ...config,
      agentName:  agentName.trim()  || undefined,
      relayAddr:  relayAddr.trim()  || undefined,
      rpcUrl:     rpcUrl.trim()     || undefined,
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
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: C.bg },
  content:     { padding: 24 },
  heading:     { fontSize: 11, color: C.sub, letterSpacing: 4, marginBottom: 24 },
  section:     {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    marginBottom: 16,
    overflow: 'hidden',
  },
  field:       { padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  fieldLabel:  { fontSize: 10, color: C.sub, letterSpacing: 2, marginBottom: 8 },
  input:       {
    color: C.text,
    fontFamily: 'monospace',
    fontSize: 14,
    paddingVertical: 0,
  },
  saveBtn:     {
    backgroundColor: C.green,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  saveBtnText: { fontSize: 13, fontWeight: '700', letterSpacing: 3, color: '#000' },
  toggleRow:   {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  toggleLabel: { fontSize: 11, color: C.text, letterSpacing: 2, fontWeight: '600' },
  toggleSub:   { fontSize: 12, color: C.sub, marginTop: 4 },
  nodeBtn:     {
    margin: 16,
    borderWidth: 1,
    borderRadius: 4,
    paddingVertical: 14,
    alignItems: 'center',
  },
  nodeBtnText: { fontSize: 13, fontWeight: '700', letterSpacing: 3 },
});
