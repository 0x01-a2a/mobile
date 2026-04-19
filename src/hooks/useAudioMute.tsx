/**
 * useAudioMute — global mute state for ZeroClaw ambient working sounds.
 *
 * The audio session stays alive when muted (volume 0 on the player node);
 * only audible output is suppressed. This keeps the background process warm
 * while respecting the user's preference.
 *
 * State is persisted in AsyncStorage and synced to the iOS native layer.
 * The Dynamic Island mute/unmute Links fire zerox1://mute-audio and
 * zerox1://unmute-audio deep links, handled here via Linking.addEventListener.
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NodeModule } from '../native/NodeModule';

const STORAGE_KEY = 'zerox1:audio_muted';

interface AudioMuteCtx {
  muted: boolean;
  toggle: () => void;
}

const AudioMuteContext = createContext<AudioMuteCtx>({ muted: false, toggle: () => {} });

export function AudioMuteProvider({ children }: { children: React.ReactNode }) {
  const [muted, setMutedState] = useState(false);
  // Avoid stale closure in the Linking handler
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const applyMute = useCallback((next: boolean) => {
    setMutedState(next);
    mutedRef.current = next;
    AsyncStorage.setItem(STORAGE_KEY, next ? '1' : '0').catch(() => {});
    if (Platform.OS === 'ios') {
      NodeModule.setAudioMuted(next).catch(() => {});
    }
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(v => {
      if (v === '1') applyMute(true);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle zerox1://mute-audio and zerox1://unmute-audio deep links
  // (fired from the Dynamic Island expanded speaker button)
  useEffect(() => {
    const handler = ({ url }: { url: string }) => {
      if (url === 'zerox1://mute-audio') applyMute(true);
      else if (url === 'zerox1://unmute-audio') applyMute(false);
    };
    const sub = Linking.addEventListener('url', handler);
    // Handle cold-start URL
    Linking.getInitialURL().then(url => { if (url) handler({ url }); }).catch(() => {});
    return () => sub.remove();
  }, [applyMute]);

  const toggle = useCallback(() => applyMute(!mutedRef.current), [applyMute]);

  return (
    <AudioMuteContext.Provider value={{ muted, toggle }}>
      {children}
    </AudioMuteContext.Provider>
  );
}

export function useAudioMute(): AudioMuteCtx {
  return useContext(AudioMuteContext);
}
