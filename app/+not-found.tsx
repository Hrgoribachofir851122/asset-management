/**
 * app/+not-found.tsx — Fallback route of the standalone app.
 * Routes users back to the main Asset-Management tab.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Compass } from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';

export default function NotFoundScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Compass size={48} color={colors.dark.textMuted} />
      <Text style={styles.title}>این صفحه پیدا نشد</Text>
      <Pressable style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]} onPress={() => router.replace('/(tabs)')}>
        <Text style={styles.buttonText}>بازگشت به مدیریت دارایی</Text>
      </Pressable>
    </View>
  );
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
      backgroundColor: colors.dark.background,
      padding: 24,
    },
    title: {
      fontSize: 16,
      fontWeight: '700' as const,
      color: colors.dark.text,
    },
    button: {
      backgroundColor: colors.dark.accent,
      borderRadius: 12,
      paddingHorizontal: 20,
      paddingVertical: 12,
      marginTop: 6,
    },
    buttonText: {
      color: colors.dark.background,
      fontWeight: '700' as const,
      fontSize: 14,
    },
  })
);
