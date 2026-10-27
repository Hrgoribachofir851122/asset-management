/**
 * colors.ts — Theme runtime for the whole app.
 *
 * Every screen/component imports `colors` and reads `colors.dark.X`.
 * To support a runtime light/dark switch WITHOUT rewriting ~25 screens:
 *   1. `dark` is a LIVE palette object — when the user switches theme we
 *      MUTATE its properties in place (Object.assign) with the light values
 *      (or restore the dark snapshot) and bump `themeVersion`.
 *   2. Module-level `StyleSheet.create(...)` blocks are wrapped with
 *      `createThemedStyles(...)` (utils/themeStyles.ts) which rebuilds the
 *      stylesheet whenever `themeVersion` changes.
 *   3. Inline styles / icon colors read `colors.dark.X` at render time, so
 *      they pick up the new palette on the forced re-render automatically.
 */

export type ThemeMode = 'dark' | 'light';

const DARK_SNAPSHOT = {
  background: '#0B0E11',
  surface: '#1E2329',
  surfaceLight: '#2B3139',
  card: '#161A1E',
  cardBorder: '#2B3139',
  text: '#EAECEF',
  textSecondary: '#848E9C',
  textMuted: '#5E6673',
  accent: '#F0B90B',
  accentDim: '#F0B90B22',
  green: '#0ECB81',
  greenDim: '#0ECB8118',
  red: '#F6465D',
  redDim: '#F6465D18',
  blue: '#1E90FF',
  blueDim: '#1E90FF18',
  orange: '#F7931A',
  orangeDim: '#F7931A18',
  border: '#2B3139',
  inputBg: '#2B3139',
  statusBar: '#0B0E11',
};

/** Light palette — same keys as dark, light values (Binance-style light UI). */
const LIGHT: typeof DARK_SNAPSHOT = {
  background: '#F4F5F7',
  surface: '#FFFFFF',
  surfaceLight: '#EDEFF2',
  card: '#FFFFFF',
  cardBorder: '#E3E6EA',
  text: '#181B20',
  textSecondary: '#4B5563',
  textMuted: '#8B93A1',
  accent: '#C08A00',
  accentDim: '#F0B90B26',
  green: '#07855D',
  greenDim: '#0ECB8126',
  red: '#D72B45',
  redDim: '#F6465D26',
  blue: '#0B62D6',
  blueDim: '#1E90FF26',
  orange: '#D97706',
  orangeDim: '#F7931A26',
  border: '#E3E6EA',
  inputBg: '#EDEFF2',
  statusBar: '#F4F5F7',
};

/** The live palette. Screens read `colors.dark.<key>` — always current. */
export const dark: typeof DARK_SNAPSHOT = { ...DARK_SNAPSHOT };
/** Static light palette (kept for completeness / direct access). */
export const light: typeof DARK_SNAPSHOT = { ...LIGHT };

let themeMode: ThemeMode = 'dark';
let themeVersion = 0;

/** Switch the whole app palette at runtime (mutation + version bump). */
export function setThemeMode(mode: ThemeMode): void {
  if (mode === themeMode) return;
  themeMode = mode;
  Object.assign(dark, mode === 'light' ? LIGHT : DARK_SNAPSHOT);
  themeVersion += 1;
}

/** Current theme mode. */
export function getThemeMode(): ThemeMode {
  return themeMode;
}

/** Bumped on every switch — used by createThemedStyles for cache busting. */
export function getThemeVersion(): number {
  return themeVersion;
}

const colors = { dark, light, setThemeMode, getThemeMode, getThemeVersion };
export default colors;
