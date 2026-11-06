/**
 * themeStyles.ts — drop-in replacement for module-level StyleSheet.create.
 *
 * Before:
 *   const styles = StyleSheet.create({ card: { backgroundColor: colors.dark.card } });
 *
 * After:
 *   const styles = createThemedStyles(() =>
 *     StyleSheet.create({ card: { backgroundColor: colors.dark.card } })
 *   );
 *
 * `styles` is a Proxy: on first access (and after every theme switch) the
 * factory runs again against the CURRENT palette, so both dark and light
 * themes render correctly without touching any `styles.x` usage in the
 * screens. Zero-cost when the theme never changes (factory runs once).
 */
import { getThemeVersion } from '@/constants/colors';

type AnyRecord = Record<string, any>;

export function createThemedStyles<S extends () => AnyRecord>(make: S): ReturnType<S> {
  let version = -1;
  let cached: AnyRecord | null = null;

  return new Proxy({} as ReturnType<S>, {
    get(_target, prop) {
      const v = getThemeVersion();
      if (cached === null || v !== version) {
        version = v;
        cached = make();
      }
      return (cached as AnyRecord)[prop as any];
    },
    has(_target, prop) {
      const v = getThemeVersion();
      if (cached === null || v !== version) {
        version = v;
        cached = make();
      }
      return prop in (cached as object);
    },
  });
}
