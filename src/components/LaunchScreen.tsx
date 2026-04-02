import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';

const LOGO = require('../assets/logo.png');

interface Props {
  onDone: () => void;
}

/**
 * 2.4s launch animation.
 *
 * 0.0 – 0.6s  logo scales + fades in
 * 0.6 – 0.8s  brief hold
 * 0.8 – 1.4s  pulse ring expands + fades (sonar ping)
 * 1.2 – 1.6s  "PILOT" label fades in
 * 1.8 – 2.4s  screen fades out → onDone
 */
export function LaunchScreen({ onDone }: Props) {
  const logoOpacity    = useRef(new Animated.Value(0)).current;
  const logoScale      = useRef(new Animated.Value(0.88)).current;
  const pulseScale     = useRef(new Animated.Value(0.85)).current;
  const pulseOpacity   = useRef(new Animated.Value(0)).current;
  const labelOpacity   = useRef(new Animated.Value(0)).current;
  const screenOpacity  = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      // 0 → 0.6s: logo blooms in
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(logoScale, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      // 0.6 → 0.8s: hold
      Animated.delay(200),
      // 0.8 → 1.5s: pulse ring expands + fades; label fades in in parallel
      Animated.parallel([
        Animated.sequence([
          Animated.timing(pulseOpacity, {
            toValue: 0.5,
            duration: 80,
            useNativeDriver: true,
          }),
          Animated.parallel([
            Animated.timing(pulseScale, {
              toValue: 2.6,
              duration: 900,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(pulseOpacity, {
              toValue: 0,
              duration: 900,
              easing: Easing.in(Easing.cubic),
              useNativeDriver: true,
            }),
          ]),
        ]),
        Animated.sequence([
          Animated.delay(200),
          Animated.timing(labelOpacity, {
            toValue: 1,
            duration: 400,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ]),
      // hold at full
      Animated.delay(300),
      // fade out
      Animated.timing(screenOpacity, {
        toValue: 0,
        duration: 400,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => onDone());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View style={[s.root, { opacity: screenOpacity }]}>
      {/* Pulse ring — sits behind the logo */}
      <Animated.View
        style={[
          s.pulseRing,
          { opacity: pulseOpacity, transform: [{ scale: pulseScale }] },
        ]}
      />

      {/* App logo */}
      <Animated.Image
        source={LOGO}
        style={[s.logo, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}
        resizeMode="contain"
      />

      {/* PILOT label */}
      <Animated.Text style={[s.label, { opacity: labelOpacity }]}>
        PILOT
      </Animated.Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 112,
    height: 112,
  },
  pulseRing: {
    position: 'absolute',
    width: 112,
    height: 112,
    borderRadius: 56,
    borderWidth: 3,
    borderColor: '#38bdf8',
  },
  label: {
    marginTop: 24,
    fontSize: 10,
    fontWeight: '600',
    color: '#6b7280',
    letterSpacing: 4,
  },
});
