import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function TodayScreen() {
  return (
    <View style={s.root}>
      <Text style={s.label}>Today</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  label: { fontSize: 16, color: '#111' },
});
