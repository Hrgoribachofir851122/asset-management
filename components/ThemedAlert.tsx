/**
 * components/ThemedAlert.tsx — v1.5.7
 *
 * «تمام پیغام‌های درون برنامه در همه بخش‌ها مودالشون درون برنامه و هماهنگ
 * با تم برنامه باشه» — جایگزین کامل Alert.alert سیستم:
 *   • مودال درون برنامه‌ای با همان ظاهر/تم مودال ویرایش TP/SL بک‌تست
 *     (پس‌زمینه surface، حاشیه border، گوشه گرد ۱۴، دکمه‌های پررنگ).
 *   • API یکسان با Alert: ThemedAlert.alert(title, message?, buttons?).
 *   • دکمه‌ها: destructive قرمز، cancel خاکستری با حاشیه، default سبز.
 *   • لمس بیرونِ مودال = عمل دکمه‌ی cancel (اگر بود) — مثل رفتار Alert اندروید.
 *   • صف ساده: هر alert جدید جای قبلی را می‌گیرد (Alert هم همین‌طور است).
 *
 * میزبانی: <ThemedAlertHost /> در app/_layout.tsx (بالای Stack) — یک نمونه
 * در کل برنامه. همه صفحات/کامپوننت‌ها ThemedAlert.alert صدا می‌زنند؛ نیازی به
 * prop drilling یا context نیست.
 */

import React, { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View, StyleSheet } from 'react-native';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react-native';
import colors from '@/constants/colors';

export type ThemedAlertButtonStyle = 'default' | 'cancel' | 'destructive';

export interface ThemedAlertButton {
  text: string;
  onPress?: () => void;
  style?: ThemedAlertButtonStyle;
}

interface ThemedAlertState {
  title: string;
  message?: string;
  buttons: ThemedAlertButton[];
  kind: 'info' | 'success' | 'error' | 'warn';
}

type Listener = (a: ThemedAlertState | null) => void;
const listeners = new Set<Listener>();
let current: ThemedAlertState | null = null;

function notify(): void {
  for (const l of listeners) {
    try {
      l(current);
    } catch {}
  }
}

function classify(title: string, message?: string): ThemedAlertState['kind'] {
  const t = `${title} ${message ?? ''}`;
  if (/خطا|ناموفق|نشد|ممکن نشد|دسترسی داده نشد|نامعتبر|ارور/i.test(t)) return 'error';
  if (/ذخیره شد|شد ✅|موفق|آماده|فعال شد|ریست شد|ساخته شد|حذف شد/i.test(t)) return 'success';
  if (/توجه|هشدار|مطمئن|تایید|خطر|قطع کنید|غیرممکن|بسته شود|حذف شود/i.test(t)) return 'warn';
  return 'info';
}

const themedAlertApi = {
  alert(title: string, message?: string, buttons?: ThemedAlertButton[]): void {
    const list =
      buttons && buttons.length > 0
        ? buttons.map((b) => ({ ...b, style: b.style ?? 'default' }))
        : [{ text: 'باشه', style: 'default' as ThemedAlertButtonStyle }];
    current = { title, message, buttons: list, kind: classify(title, message) };
    notify();
  },
  dismiss(): void {
    current = null;
    notify();
  },
};

export const ThemedAlert = themedAlertApi;

export function ThemedAlertHost(): React.ReactElement {
  const [state, setState] = useState<ThemedAlertState | null>(null);

  useEffect(() => {
    const l: Listener = (a) => setState(a);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const close = (btn?: ThemedAlertButton) => {
    current = null;
    setState(null);
    btn?.onPress?.();
  };

  const icon = (() => {
    if (!state) return null;
    const c =
      state.kind === 'error'
        ? colors.dark.red
        : state.kind === 'success'
          ? colors.dark.green
          : state.kind === 'warn'
            ? '#F0B90B'
            : colors.dark.accent;
    if (state.kind === 'error') return <XCircle size={22} color={c} />;
    if (state.kind === 'success') return <CheckCircle2 size={22} color={c} />;
    if (state.kind === 'warn') return <AlertTriangle size={22} color={c} />;
    return <Info size={22} color={c} />;
  })();

  return (
    <Modal visible={!!state} transparent animationType="fade" onRequestClose={() => close(state?.buttons.find((b) => b.style === 'cancel') ?? state?.buttons[0])}>
      {state ? (
        <Pressable style={styles.overlay} onPress={() => close(state.buttons.find((b) => b.style === 'cancel'))}>
          <View style={styles.card} onStartShouldSetResponder={() => true}>
            <View style={styles.headRow}>
              {icon}
              <Text style={styles.title}>{state.title}</Text>
            </View>
            {typeof state.message === 'string' && state.message.length > 0 ? (
              <Text style={styles.message}>{state.message}</Text>
            ) : null}
            <View style={styles.buttonRow}>
              {state.buttons.map((b, i) => (
                <Pressable
                  key={`${b.text}-${i}`}
                  style={[
                    styles.btn,
                    b.style === 'destructive' && styles.btnDestructive,
                    b.style === 'cancel' && styles.btnCancel,
                    state.buttons.length === 1 && styles.btnSingle,
                  ]}
                  onPress={() => close(b)}
                >
                  <Text
                    style={[
                      styles.btnText,
                      b.style === 'cancel' && styles.btnCancelText,
                      state.buttons.length === 1 && styles.btnSingleText,
                    ]}
                  >
                    {b.text}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Pressable>
      ) : (
        <View />
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  // همان زبان بصری مودال ویرایش TP/SL بک‌تست (tpslModal)
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.dark.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.dark.border,
    padding: 16,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontWeight: '900',
    color: colors.dark.text,
    textAlign: 'right',
  },
  message: {
    fontSize: 11,
    color: colors.dark.textSecondary,
    lineHeight: 17,
    textAlign: 'right',
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row-reverse',
    gap: 8,
    marginTop: 4,
  },
  btn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 11,
    backgroundColor: colors.dark.green,
  },
  btnDestructive: {
    backgroundColor: colors.dark.red,
  },
  btnCancel: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  btnSingle: {},
  btnText: {
    fontSize: 12.5,
    fontWeight: '900',
    color: colors.dark.background,
  },
  btnCancelText: {
    color: colors.dark.text,
  },
  btnSingleText: {},
});
