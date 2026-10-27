/**
 * scanServerApi.ts — STANDALONE BUILD (اپ مستقل «مدیریت دارایی»)
 *
 * In the original Pampi project this file was the client bridge to the
 * server-side scheduled scanner (signals, bot config sync, push registration).
 * None of those features exist in the standalone Asset-Management app, so the
 * original 28KB file was replaced with this minimal shim that keeps the ONE
 * function still consumed by kept code:
 *
 *   utils/nobitexApi.ts  →  getServerUrl()   (Nobitex / Alan.Chand backend proxy)
 *
 * Behavior is byte-compatible with the original getServerUrl():
 * the stored override (@scan_server_url) wins, otherwise the baked-in
 * default (EXPO_PUBLIC_SCANNER_SERVER_URL env or the project backend).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL_KEY = '@scan_server_url';

/**
 * The app's own backend, always baked into the app (hidden default).
 * Users who deploy their own copy (Railway/other host) can override it via AsyncStorage.
 */
const DEFAULT_SERVER_URL =
  process.env.EXPO_PUBLIC_SCANNER_SERVER_URL ?? 'https://asset-management1.up.railway.app';

let cachedServerUrl: string | null = null;

/** Resolves the backend base URL (cached after the first call). */
export async function getServerUrl(): Promise<string> {
  if (cachedServerUrl) return cachedServerUrl;
  try {
    const stored = await AsyncStorage.getItem(SERVER_URL_KEY);
    cachedServerUrl = (stored && stored.trim()) || DEFAULT_SERVER_URL;
  } catch (e) {
    console.log('[ScanServer] Error loading server URL:', e);
    cachedServerUrl = DEFAULT_SERVER_URL;
  }
  return cachedServerUrl ?? DEFAULT_SERVER_URL;
}

/** Persists a custom backend URL (empty string → back to default). */
export async function setServerUrl(url: string): Promise<void> {
  const clean = url.trim();
  try {
    if (clean) {
      await AsyncStorage.setItem(SERVER_URL_KEY, clean);
    } else {
      await AsyncStorage.removeItem(SERVER_URL_KEY);
    }
    cachedServerUrl = null; // force re-resolve on next getServerUrl()
  } catch (e) {
    console.log('[ScanServer] Error saving server URL:', e);
  }
}
