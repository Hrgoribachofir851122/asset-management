import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Modal } from 'react-native';
import { ChevronDown, Check } from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';

interface DropdownOption {
  key: string;
  label: string;
}

interface DropdownPickerProps {
  label: string;
  value: string;
  options: DropdownOption[];
  onSelect: (key: string) => void;
  testID?: string;
  /**
   * v1.4.0 — برچسب روی خودِ نوار بسته هم دیده شود (نه فقط داخل مودال باز).
   * نوار بسته به‌جای یک عدد بی‌مقدمه، «برچسب: مقدار» نشان می‌دهد تا معلوم
   * باشد هر نوار مال کدام تنظیم است.
   */
  showLabelOnBar?: boolean;
  /** v1.4.0 — رنگ پس‌زمینهٔ نوار بسته (پیش‌فرض inputBg) */
  triggerBackgroundColor?: string;
}

export default function DropdownPicker({
  label,
  value,
  options,
  onSelect,
  testID,
  showLabelOnBar = false,
  triggerBackgroundColor,
}: DropdownPickerProps) {
  const [open, setOpen] = useState(false);
  const selectedLabel = options.find((o) => o.key === value)?.label ?? value;

  return (
    <>
      <Pressable
        style={[
          styles.dropdownTrigger,
          showLabelOnBar && styles.dropdownTriggerRtl,
          triggerBackgroundColor ? { backgroundColor: triggerBackgroundColor } : null,
        ]}
        onPress={() => setOpen(true)}
        testID={testID}
      >
        {showLabelOnBar && (
          <Text style={styles.dropdownBarLabel} numberOfLines={1}>
            {label}
          </Text>
        )}
        <Text style={styles.dropdownTriggerText}>{selectedLabel}</Text>
        <ChevronDown size={16} color={colors.dark.textSecondary} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setOpen(false)}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{label}</Text>
            <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
              {options.map((opt) => (
                <Pressable
                  key={opt.key}
                  style={[
                    styles.modalOption,
                    value === opt.key && styles.modalOptionActive,
                  ]}
                  onPress={() => {
                    onSelect(opt.key);
                    setOpen(false);
                  }}
                >
                  <Text
                    style={[
                      styles.modalOptionText,
                      value === opt.key && styles.modalOptionTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                  {value === opt.key && <Check size={16} color={colors.dark.accent} />}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = createThemedStyles(() => StyleSheet.create({
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.dark.inputBg,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  dropdownTriggerText: {
    fontSize: 14,
    color: colors.dark.text,
    flex: 1,
    textAlign: 'right',
  },
  // v1.4.0 — برچسبِ روی نوار بسته: چیدمان راست‌به‌چپ [برچسب][مقدار][فلش]
  dropdownTriggerRtl: {
    flexDirection: 'row-reverse',
  },
  dropdownBarLabel: {
    fontSize: 12,
    color: colors.dark.textMuted,
    textAlign: 'right',
    marginLeft: 8,
    flexShrink: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: colors.dark.card,
    borderRadius: 20,
    padding: 20,
    width: '100%',
    maxHeight: '70%',
    borderWidth: 1,
    borderColor: colors.dark.cardBorder,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: colors.dark.text,
    textAlign: 'center',
    marginBottom: 16,
  },
  modalScroll: {
    maxHeight: 400,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginBottom: 4,
  },
  modalOptionActive: {
    backgroundColor: colors.dark.accentDim,
  },
  modalOptionText: {
    fontSize: 14,
    color: colors.dark.text,
    flex: 1,
    textAlign: 'right',
  },
  modalOptionTextActive: {
    color: colors.dark.accent,
    fontWeight: '700' as const,
  },
}));
