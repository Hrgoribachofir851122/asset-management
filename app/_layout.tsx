/**
 * app/_layout.tsx — Root layout of the standalone «مدیریت دارایی» app.
 *
 * Mirrors the Pampi root wiring that the wallet section relies on:
 *   QueryClientProvider (react-query) → AppProvider (settings/theme)
 *   → GestureHandlerRootView → SafeAreaProvider → root Stack.
 *
 * The theme is read from the context (persisted «ظاهر برنامه» setting) so the
 * StatusBar matches the light/dark palette managed by constants/colors.ts.
 */

import React, { useEffect } from 'react';
import { View, StyleSheet, AppState, AppStateStatus } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import colors, { type ThemeMode } from '@/constants/colors';
import { AppProvider, useApp } from '@/contexts/AppContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

/**
 * Refetch pause/resume on background — same UX as the original app: live
 * price queries (TGJU, Binance, blockchain RPC…) stop when the app is
 * backgrounded and resume when it comes back to the foreground.
 */
function useReactQueryAppStateSync() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    });
    return () => sub.remove();
  }, []);
}

function RootNavigator() {
  const { themeMode } = useApp();
  const mode: ThemeMode = themeMode ?? 'dark';
  const palette = mode === 'light' ? colors.light : colors.dark;

  return (
    <View style={styles.container}>
      <StatusBar
        style={mode === 'light' ? 'dark' : 'light'}
        backgroundColor={palette.statusBar}
      />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: palette.background },
        }}
      >
        <Stack.Screen name="(tabs)" />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  useReactQueryAppStateSync();

  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AppProvider>
            <RootNavigator />
          </AppProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1 },
});
