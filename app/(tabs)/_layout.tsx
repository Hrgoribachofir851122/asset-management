/**
 * app/(tabs)/_layout.tsx — Bottom tab bar of the standalone app.
 *
 * v1.5.0 — THREE tabs (user-approved plan): the new FIRST tab «قیمت‌ها»
 * (PriceBoard — all live prices incl. dual USD/Toman BTC & ETH), then
 * «مدیریت دارایی» (the wallet screen) and «تنظیمات».
 *
 * v1.5.1 — the app now OPENS on «قیمت‌ها» (user request): live prices are
 * the first thing you see; مدیریت دارایی stays one tap away.
 *
 * Under RTL (Persian devices) the FIRST declared tab renders at the far
 * RIGHT — so this declaration order produces, right → left:
 *     قیمت‌ها ← مدیریت دارایی ← تنظیمات
 *
 * The tab bar is themed manually (lucide icons + live colors.dark palette)
 * exactly like the original Pampi tabs layout.
 */

import { Tabs } from 'expo-router';
import { Settings, TrendingUp, Wallet } from 'lucide-react-native';
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
      initialRouteName="prices/index"
    >
      <Tabs.Screen
        name="prices/index"
        options={{
          title: 'قیمت‌ها',
          tabBarIcon: ({ color, size }) => <TrendingUp size={size} color={color} />,
        }}
      />
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
