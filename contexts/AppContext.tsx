/**
 * AppContext.tsx — STANDALONE BUILD (اپ مستقل «مدیریت دارایی»)
 *
 * This is a LIGHTWEIGHT rewrite of the original Pampi AppContext (28KB → ~4KB).
 * The original context powered the whole Pampi app (signals, telegram,
 * gainz-algo schedulers, push notifications, whale wallets…). The standalone
 * Asset-Management app only needs a small slice of that surface:
 *
 *   1. settings.refreshInterval  — used by app/(tabs)/wallet/index.tsx
 *      (refreshMs = settings.refreshInterval * 60_000, min 10s — see the
 *      «بازه بروزرسانی» setting, settings-extract/01+02 in docs/)
 *   2. settings.themeMode + setAppThemeMode() — light/dark theme, applied via
 *      the same runtime palette mutation as the original (constants/colors.ts)
 *   3. updateSettings() — the generic partial-settings setter
 *
 * The public shape (AppProvider / useApp / settings / updateSettings /
 * setAppThemeMode / themeMode) matches the original, so the wallet screen
 * stays byte-for-byte identical to Pampi v1.5.12.
 *
 * Settings are persisted under a NEW key (@asset_management_settings) so the
 * standalone app starts with clean defaults and never fights with the keys
 * the full Pampi app may have written on the same device.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import createContextHook from '@nkzw/create-context-hook';
import { AppSettings } from '@/types/crypto';
import { setThemeMode as applyPalette, getThemeMode, type ThemeMode } from '@/constants/colors';

const SETTINGS_KEY = '@asset_management_settings';

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  apiSecret: '',
  scanInterval: 60,
  volumeThreshold: 2.0,
  notificationsEnabled: true,
  scannerNotifications: true,
  whaleNotifications: true,
  exchange: 'binance',
  marginAmount: 100,
  leverage: 10,
  riskRewardRatio: 2,
  indicators: [],
  selectedIndicatorIds: [],
  customCoins: [],
  useCustomCoinsOnly: false,
  // «بازه بروزرسانی خودکار» — 5 دقیقه، دقیقاً مثل پیش‌فرض پامپی
  refreshInterval: 5,
  scanFilterMode: 'all',
  useVolumeOnlySignals: false,
  memeShortNotifications: true,
  preListingNotifications: true,
  tradeAiNotifications: true,
  gainzAlgoNotifications: true,
  gainzTimeframes: ['1d'],
  arzinjaApiKey: '70c505037afe7c40be8dd6b10ba92d73',
  arzinjaApiSecret: '6986dce5b5d4f758da59b85d7102a7d7f05ebf30df320018610b8c9281319419',
  hookReversalNotifications: true,
  hookTimeframes: ['1d'],
  telegramBotToken: '',
  telegramChatId: '',
  telegramEnabled: false,
  themeMode: 'dark' as ThemeMode,
  autoScanEnabled: false,
};

async function loadSettings(): Promise<AppSettings> {
  try {
    const stored = await AsyncStorage.getItem(SETTINGS_KEY);
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch (e) {
    console.log('[AppContext] Error loading settings:', e);
  }
  return DEFAULT_SETTINGS;
}

export const [AppProvider, useApp] = createContextHook(() => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Boot: load persisted settings, then apply the persisted theme to the
  // runtime palette (same pattern as the original context's applyPalette
  // effect — the wallet screens read colors.dark.* at render time).
  useEffect(() => {
    let mounted = true;
    loadSettings().then((loaded) => {
      if (!mounted) return;
      setSettings(loaded);
      applyPalette((loaded.themeMode as ThemeMode) ?? 'dark');
      setIsLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Debounced persistence — rapid setting changes (dropdown scrolling etc.)
  // coalesce into a single AsyncStorage write.
  const persist = useCallback((next: AppSettings) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)).catch((e) =>
        console.log('[AppContext] Error saving settings:', e)
      );
    }, 150);
  }, []);

  const updateSettings = useCallback(
    (newSettings: Partial<AppSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...newSettings };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const setAppThemeMode = useCallback(
    (mode: ThemeMode) => {
      // 1) mutate the live palette immediately (constants/colors.ts)
      applyPalette(mode);
      // 2) persist + trigger a re-render of every useApp() consumer
      updateSettings({ themeMode: mode });
    },
    [updateSettings]
  );

  return {
    settings,
    isLoaded,
    updateSettings,
    setAppThemeMode,
    themeMode: (settings.themeMode as ThemeMode) ?? 'dark',
  };
});
