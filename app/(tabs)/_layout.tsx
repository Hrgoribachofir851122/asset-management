/**
 * app/(tabs)/_layout.tsx — Bottom tab bar of the standalone app.
 *
 * Two tabs: «مدیریت دارایی» (the wallet screen, kept byte-for-byte from
 * Pampi v1.5.12) and «تنظیمات» (refresh interval + theme + help).
 *
 * Under RTL (Persian devices) the FIRST declared tab renders at the far
 * RIGHT — so this declaration order produces, right → left:
 *     مدیریت دارایی ← تنظیمات
 * The app always opens on «مدیریت دارایی».
 *
 * The tab bar is themed manually (lucide icons + live colors.dark palette)
 * exactly like the original Pampi tabs layout.
 */

import { Tabs } from 'expo-router';
import { Settings, Wallet } from 'lucide-react-native';
import colors from '@/constants/colors';
import { useApp } from '@/contexts/AppContext';
import React from 'react';

export default function TabsLayout() {
  // Re-render on theme switch so the bar picks up the mutated palette.
  useApp();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.dark.accent,
        tabBarInactiveTintColor: colors.dark.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.dark.surface,
          borderTopColor: colors.dark.border,
        },
        sceneStyle: { backgroundColor: colors.dark.background },
      }}
    >
      <Tabs.Screen
        name="wallet"
        options={{
          title: 'مدیریت دارایی',
          tabBarIcon: ({ color, size }) => <Wallet size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings/index"
        options={{
          title: 'تنظیمات',
          tabBarIcon: ({ color, size }) => <Settings size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
