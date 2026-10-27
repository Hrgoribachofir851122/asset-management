import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, ScrollView } from 'react-native';
import {
  Link as LinkIcon,
  Plus,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Lock,
  Info,
  AlertTriangle,
  ShieldAlert,
  RefreshCcw,
  Check,
  Pencil,
} from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import { formatToman } from '@/utils/nobitexApi';
import { formatFullToman } from '@/utils/iranMarketApi';
import { VpnStatus } from '@/utils/vpnGuard';
import {
  BlockchainWallet,
  BlockchainWalletData,
  BlockchainNetwork,
  NETWORKS,
  NETWORK_GROUPS,
  EVM_NETWORKS,
  shortAddress,
  validateAddressForNetworks,
  validateBlockchainAddress,
  isEvmNetwork,
} from '@/utils/blockchainWallets';
import {
  BlockchainPnlSummary,
  PNL_PERIODS,
  PnlPeriod,
} from '@/utils/blockchainWalletApi';

import { ThemedAlert } from '@/components/ThemedAlert';
/**
 * BlockchainWalletsSection — v1.4.17
 *
 * The 4th top tab of the asset-management screen: «کیف پول بلاکچین».
 *
 * READ-ONLY blockchain wallets (Trust Wallet & any personal wallet):
 *   - ONE public address tracked on MANY networks at once.
 *   - v1.4.17 NEW: the network picker is a COLLAPSIBLE multi-select dropdown
 *     («منوی کشویی شبکه‌ها») with a manual check-mark per network — every
 *     Trust-Wallet-supported network is listed (51 networks), grouped into
 *     «شبکه‌های اتریومی (یک آدرس 0x)» + «شبکه‌های مستقل».
 *   - 3-LEVEL PnL: total (top, with timeframe chips) → one line per wallet
 *     → per-token rows when the wallet is expanded.
 *   - Per-wallet refresh button actually refetches (v1.4.16 bug fix).
 */

const PNL_PERIOD_LABEL: Record<PnlPeriod, string> = {
  1: 'امروز',
  7: '۷ روز',
  30: '۳۰ روز',
  90: '۹۰ روز',
  180: '۱۸۰ روز',
};

export interface BlockchainWalletsSectionProps {
  wallets: BlockchainWallet[];
  balanceByWallet: Record<
    string,
    { data?: BlockchainWalletData; isFetching: boolean; error?: unknown }
  >;
  usdtToToman: number;
  pnlSummary?: BlockchainPnlSummary;
  pnlLoading: boolean;
  vpnStatus: VpnStatus;
  vpnChecking: boolean;
  onRecheckVpn: () => void;
  onAddWallet: (
    name: string,
    networks: BlockchainNetwork[],
    address: string,
    networkAddresses?: Partial<Record<BlockchainNetwork, string>>
  ) => Promise<boolean>;
  onEditWallet: (
    id: string,
    name: string,
    networks: BlockchainNetwork[],
    networkAddresses?: Partial<Record<BlockchainNetwork, string>>
  ) => Promise<boolean>;
  onRemoveWallet: (id: string, name: string) => void;
  onRefreshAll: () => void;
  onRefreshWallet: (id: string) => void;
  /** v1.4.19 — per-wallet manual-refresh spinner state (id → busy). */
  manualRefreshing?: Record<string, boolean>;
  /** v1.4.19 — transient refresh result message («به‌روز شد — …»). */
  refreshToast?: string | null;
}

export default function BlockchainWalletsSection({
  wallets,
  balanceByWallet,
  usdtToToman,
  pnlSummary,
  pnlLoading,
  vpnStatus,
  vpnChecking,
  onRecheckVpn,
  onAddWallet,
  onEditWallet,
  onRemoveWallet,
  onRefreshAll,
  onRefreshWallet,
  manualRefreshing,
  refreshToast,
}: BlockchainWalletsSectionProps) {
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingWalletId, setEditingWalletId] = useState<string | null>(null);
  const [pnlPeriod, setPnlPeriod] = useState<PnlPeriod>(7);

  const totalUsd = useMemo(
    () =>
      wallets.reduce(
        (s, w) => s + (balanceByWallet[w.id]?.data?.totalUsd ?? 0),
        0
      ),
    [wallets, balanceByWallet]
  );
  const totalToman = usdtToToman > 0 ? totalUsd * usdtToToman : 0;
  const anyFetching = wallets.some((w) => balanceByWallet[w.id]?.isFetching);
  const vpnBlocked = vpnStatus === 'iran';

  return (
    <>
      {/* ── کارت مجموع کیف پول‌های بلاکچین ── */}
      <View style={styles.portfolioCard}>
        <View style={styles.portfolioHeader}>
          <LinkIcon size={20} color={colors.dark.accent} />
          <Text style={styles.portfolioTitle}>مجموع کیف پول‌های بلاکچین</Text>
          <Pressable style={styles.refreshAllBtn} onPress={onRefreshAll} disabled={anyFetching}>
            {anyFetching ? (
              <ActivityIndicator size="small" color={colors.dark.accent} />
            ) : (
              <RefreshCw size={16} color={colors.dark.accent} />
            )}
          </Pressable>
        </View>

        <View style={styles.portfolioValues}>
          <View style={styles.portfolioValueRow}>
            <TrendingUp size={14} color={colors.dark.green} />
            <Text style={styles.portfolioValueLabel}>ارزش دلاری:</Text>
            <Text style={styles.portfolioValueAmount}>
              ${totalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </Text>
          </View>
          {usdtToToman > 0 && (
            <View style={styles.portfolioValueRow}>
              <TrendingUp size={14} color={colors.dark.blue} />
              <Text style={styles.portfolioValueLabel}>ارزش تومانی:</Text>
              <Text style={[styles.portfolioValueAmount, { color: colors.dark.blue }]}>
                {formatToman(totalToman)} تومان
              </Text>
            </View>
          )}
        </View>

        <View style={styles.tomanPriceRow}>
          <Text style={styles.tomanPriceLabel}>قیمت تتر</Text>
          <Text style={styles.tomanPriceValue}>
            {usdtToToman > 0 ? `${usdtToToman.toLocaleString('fa-IR')} تومان` : 'در حال دریافت...'}
          </Text>
        </View>

        {/* ── سود/زیان کلی (بالا صفحه + انتخاب تایم‌فریم) ── */}
        {wallets.length > 0 && (
          <BlockchainPnlCard
            pnlSummary={pnlSummary}
            wallets={wallets}
            pnlLoading={pnlLoading}
            period={pnlPeriod}
            onPeriod={setPnlPeriod}
            usdtToToman={usdtToToman}
          />
        )}

        <Text style={styles.portfolioSub}>
          {wallets.length > 0
            ? `${wallets.length.toLocaleString('fa-IR')} کیف پول • ${wallets
                .reduce((s, w) => s + w.networks.length, 0)
                .toLocaleString('fa-IR')} شبکه • فقط خواندنی`
            : 'هنوز کیف پولی اضافه نشده'}
        </Text>
      </View>

      {/* ── گیت فیلترشکن: بلاکچین‌ها API خارجی هستند ── */}
      {vpnBlocked && wallets.length > 0 && (
        <View style={styles.vpnGateCard}>
          <ShieldAlert size={22} color={colors.dark.red} />
          <View style={styles.vpnGateTexts}>
            <Text style={styles.vpnGateTitle}>فیلترشکن خاموش است (IP ایران)</Text>
            <Text style={styles.vpnGateSub}>
              خواندن موجودی کیف پول‌های بلاکچین به شبکه بین‌المللی نیاز دارد — با روشن‌کردن
              فیلترشکن، موجودی‌ها خودکار تازه می‌شوند.
            </Text>
          </View>
          <Pressable style={styles.vpnGateBtn} onPress={onRecheckVpn} disabled={vpnChecking}>
            {vpnChecking ? (
              <ActivityIndicator size="small" color={colors.dark.red} />
            ) : (
              <RefreshCcw size={16} color={colors.dark.red} />
            )}
          </Pressable>
        </View>
      )}

      {/* ── فرم افزودن کیف پول (با راهنمای فقط‌خواندنی) ── */}
      {showAddForm ? (
        <AddBlockchainWalletForm
          onCancel={() => setShowAddForm(false)}
          onSubmit={async (name, networks, address, networkAddresses) => {
            const ok = await onAddWallet(name, networks, address ?? '', networkAddresses);
            if (ok) setShowAddForm(false);
            return ok;
          }}
        />
      ) : (
        <Pressable
          style={styles.addButton}
          onPress={() => setShowAddForm(true)}
          testID="add-blockchain-wallet-button"
        >
          <Plus size={18} color={colors.dark.accent} />
          <Text style={styles.addButtonText}>افزودن کیف پول بلاکچین</Text>
        </Pressable>
      )}

      {/* ── کارت هر کیف پول (یک خط خلاصه + PnL همان تایم‌فریم) ── */}
      {wallets.map((wallet) => (
        <BlockchainWalletCard
          key={wallet.id}
          wallet={wallet}
          isExpanded={expandedWallet === wallet.id}
          data={balanceByWallet[wallet.id]?.data}
          isFetching={balanceByWallet[wallet.id]?.isFetching ?? false}
          manualRefreshing={manualRefreshing?.[wallet.id] ?? false}
          error={balanceByWallet[wallet.id]?.error}
          usdtToToman={usdtToToman}
          pnlPeriod={pnlPeriod}
          walletPnl={pnlSummary?.perWallet?.[wallet.id]?.[pnlPeriod]}
          onToggle={() =>
            setExpandedWallet(expandedWallet === wallet.id ? null : wallet.id)
          }
          onRemove={() => onRemoveWallet(wallet.id, wallet.name)}
          onRefresh={() => onRefreshWallet(wallet.id)}
          onEdit={() => {
            setEditingWalletId(wallet.id);
            setShowAddForm(false);
          }}
        />
      ))}

      {/* ── فرم ویرایش کیف پول (تغییر نام/شبکه‌ها) ── */}
      {editingWalletId &&
        (() => {
          const wallet = wallets.find((w) => w.id === editingWalletId);
          if (!wallet) return null;
          return (
            <AddBlockchainWalletForm
              editWallet={wallet}
              onCancel={() => setEditingWalletId(null)}
              onSubmit={async (name, networks, _address, networkAddresses) => {
                const ok = await onEditWallet(wallet.id, name, networks, networkAddresses);
                if (ok) setEditingWalletId(null);
                return ok;
              }}
            />
          );
        })()}

      {/* ── v1.4.19 — toast نتیجه رفرش («به‌روز شد — …») ── */}
      {refreshToast ? (
        <View style={styles.refreshToast}>
          <Text style={styles.refreshToastText} numberOfLines={1}>
            {refreshToast}
          </Text>
        </View>
      ) : null}

      {/* ── حالت خالی ── */}
      {wallets.length === 0 && !showAddForm && (
        <View style={styles.emptyState}>
          <Lock size={44} color={colors.dark.textMuted} />
          <Text style={styles.emptyTitle}>کیف پول بلاکچینی اضافه نشده</Text>
          <Text style={styles.emptySubtitle}>
            کیف پول خود را در حالت فقط‌خواندنی اضافه کنید (مثل تراست ولتم یا تون‌کیپر) — فقط با
            آدرس عمومی، بدون کلید خصوصی؛ یک آدرس را روی هر تعداد شبکه (۵۱ شبکه) همزمان دنبال کنید
            و موجودی و سود/زیان آن همراه دارایی‌هایتان محاسبه می‌شود.
          </Text>
        </View>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// PnL card (total) — timeframe chips + total + per-token rows
// ---------------------------------------------------------------------------

function BlockchainPnlCard({
  pnlSummary,
  wallets,
  pnlLoading,
  period,
  onPeriod,
  usdtToToman,
}: {
  pnlSummary?: BlockchainPnlSummary;
  /** v1.4.19 — per-wallet lines instead of per-token rows (user demand:
   *  «در PnL کل، همه کیف‌ها را یک خطی نشون بده و ارزها را نه»). */
  wallets: BlockchainWallet[];
  pnlLoading: boolean;
  period: PnlPeriod;
  onPeriod: (p: PnlPeriod) => void;
  usdtToToman: number;
}) {
  const pnl = pnlSummary?.byPeriod[period];
  const usdPnl = pnl ? pnl.usdNow - pnl.usdThen : 0;
  const pct = pnl && pnl.usdThen > 0 ? (usdPnl / pnl.usdThen) * 100 : 0;
  const positive = usdPnl >= 0;
  const tomanPnl = usdtToToman > 0 ? usdPnl * usdtToToman : 0;

  return (
    <View style={styles.pnlBox}>
      <View style={styles.pnlHeadRow}>
        {positive ? (
          <TrendingUp size={14} color={colors.dark.green} />
        ) : (
          <TrendingDown size={14} color={colors.dark.red} />
        )}
        <Text style={styles.pnlTitle}>سود / زیان کل دارایی‌ها (تغییر قیمت بازار)</Text>
      </View>

      <View style={styles.pnlPeriodRow}>
        {PNL_PERIODS.map((d) => (
          <Pressable
            key={d}
            style={[styles.pnlPeriodChip, period === d && styles.pnlPeriodChipActive]}
            onPress={() => onPeriod(d)}
          >
            <Text style={[styles.pnlPeriodText, period === d && styles.pnlPeriodTextActive]}>
              {PNL_PERIOD_LABEL[d]}
            </Text>
          </Pressable>
        ))}
      </View>

      {pnlLoading && !pnlSummary ? (
        <View style={styles.pnlLoading}>
          <ActivityIndicator size="small" color={colors.dark.accent} />
          <Text style={styles.pnlLoadingText}>دریافت تاریخچه قیمت‌ها…</Text>
        </View>
      ) : !pnl || pnl.tokens.length === 0 ? (
        <Text style={styles.pnlEmpty}>
          برای این بازه تاریخچه قیمت در دسترس نیست — بعداً دوباره تلاش می‌شود
        </Text>
      ) : (
        <>
          <Text style={[styles.pnlTotal, { color: positive ? colors.dark.green : colors.dark.red }]}>
            {positive ? '+' : '−'} ${Math.abs(usdPnl).toLocaleString('en-US', {
              maximumFractionDigits: 2,
            })}
          </Text>
          <View style={styles.pnlPctRow}>
            <View style={[styles.pnlPctChip, !positive && { backgroundColor: colors.dark.red + '1C' }]}>
              <Text style={[styles.pnlPctText, !positive && { color: colors.dark.red }]}>
                {positive ? '▲' : '▼'} {Math.abs(pct).toLocaleString('fa-IR', {
                  maximumFractionDigits: 1,
                })}٪ در {PNL_PERIOD_LABEL[period]}
              </Text>
            </View>
          </View>
          {usdtToToman > 0 && (
            <Text style={[styles.pnlToman, { color: positive ? colors.dark.green : colors.dark.red }]}>
              معادل تومانی: {positive ? '+' : '−'} {formatFullToman(Math.abs(Math.round(tomanPnl)))} تومان
            </Text>
          )}
          {/* v1.4.19 — PER-WALLET one-line PnL rows (token detail lives in
              each wallet's own card, behind its expand arrow). v1.5.0:
              «همه کیف‌ها» همیشه ردیف خودش را دارند — کیف‌های بدون داده
              قیمتِ این بازه هم با «—» نمایش داده می‌شوند، نه حذف. */}
          {wallets.map((w) => {
            const wp = pnlSummary?.perWallet?.[w.id]?.[period];
            if (!wp || wp.usdThen <= 0) {
              return (
                <View key={w.id} style={styles.pnlRow}>
                  <Text style={styles.pnlRowLabel} numberOfLines={1}>
                    {w.name}
                  </Text>
                  <Text style={[styles.pnlRowValue, { color: colors.dark.textMuted }]}>
                    — بدون داده قیمت این بازه
                  </Text>
                </View>
              );
            }
            const wUsd = wp.usdNow - wp.usdThen;
            const wPct = (wUsd / wp.usdThen) * 100;
            return (
              <View key={w.id} style={styles.pnlRow}>
                <Text style={styles.pnlRowLabel} numberOfLines={1}>
                  {w.name}
                </Text>
                <Text
                  style={[
                    styles.pnlRowValue,
                    { color: wUsd >= 0 ? colors.dark.green : colors.dark.red },
                  ]}
                >
                  {wUsd >= 0 ? '+' : '−'} ${Math.abs(wUsd).toLocaleString('en-US', {
                    maximumFractionDigits: 2,
                  })} ({Math.abs(wPct).toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪)
                </Text>
              </View>
            );
          })}
          <Text style={styles.pnlNote}>
            مبنا: موجودی امروز × قیمت پایان روزِ {PNL_PERIOD_LABEL[period]} پیش (بایننس/CoinGecko).
            تغییر ارزش بازار است، نه سود واقعی نسبت به قیمت خرید شما. جزئیات هر ارز داخل کارت همان کیف.
          </Text>
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Network multi-select DROPDOWN («منوی کشویی شبکه‌ها»)
// v1.5.0 — SPLIT into TWO dropdowns (user demand: «منوی کشویی شبکه‌های
// مستقل را از قسمت انتخاب شبکه جدا کن»): one for the EVM networks (shared
// 0x address) and a SEPARATE one for the standalone networks, each of which
// gets its own dedicated-address input right below it.
// ---------------------------------------------------------------------------

function NetworkDropdown({
  selected,
  onChange,
  group,
}: {
  /** ONLY the networks of this group (caller filters). */
  selected: BlockchainNetwork[];
  /** next selection OF THIS GROUP (caller merges with the other group). */
  onChange: (next: BlockchainNetwork[]) => void;
  group: 'evm' | 'independent';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const toggle = (n: BlockchainNetwork) => {
    onChange(selected.includes(n) ? selected.filter((x) => x !== n) : [...selected, n]);
  };

  const allEvmSelected = EVM_NETWORKS.every((n) => selected.includes(n));
  const toggleAllEvm = () => {
    if (allEvmSelected) {
      onChange(selected.filter((n) => !EVM_NETWORKS.includes(n)));
    } else {
      const set = new Set([...selected, ...EVM_NETWORKS]);
      onChange([...set]);
    }
  };

  const filter = (list: BlockchainNetwork[]) =>
    query.trim()
      ? list.filter(
          (n) =>
            NETWORKS[n].label.includes(query.trim()) ||
            NETWORKS[n].native.toLowerCase().includes(query.trim().toLowerCase()) ||
            NETWORKS[n].short.toLowerCase().includes(query.trim().toLowerCase())
        )
      : list;

  return (
    <View>
      <Pressable
        style={styles.dropdownBtn}
        onPress={() => setOpen((v) => !v)}
        testID={group === 'evm' ? 'network-dropdown-evm' : 'network-dropdown-standalone'}
      >
        <View style={styles.dropdownBtnLeft}>
          {selected.slice(0, 4).map((n) => (
            <View
              key={n}
              style={[styles.dropdownDot, { backgroundColor: NETWORKS[n].color }]}
            />
          ))}
          <Text style={styles.dropdownBtnText}>
            {selected.length === 0
              ? group === 'evm'
                ? 'انتخاب شبکه‌های اتریومی (منوی کشویی)'
                : 'انتخاب شبکه‌های مستقل — آدرس اختصاصی'
              : `${selected.length.toLocaleString('fa-IR')} شبکه ${
                  group === 'evm' ? 'اتریومی' : 'مستقل'
                } انتخاب شد`}
          </Text>
        </View>
        {open ? (
          <ChevronUp size={16} color={colors.dark.accent} />
        ) : (
          <ChevronDown size={16} color={colors.dark.accent} />
        )}
      </Pressable>

      {open && (
        <View style={styles.dropdownPanel}>
          <TextInput
            style={styles.dropdownSearch}
            value={query}
            onChangeText={setQuery}
            placeholder="جستجوی شبکه (مثلاً بیس یا SOL)…"
            placeholderTextColor={colors.dark.textMuted}
          />
          {NETWORK_GROUPS.filter((g) => g.id === group).map((grp) => {
            const list = filter(grp.networks);
            if (list.length === 0) return null;
            return (
              <View key={grp.id} style={styles.dropdownGroup}>
                <View style={styles.dropdownGroupHead}>
                  <Text style={styles.dropdownGroupTitle}>{grp.label}</Text>
                  {grp.id === 'evm' && (
                    <Pressable style={styles.dropdownGroupAction} onPress={toggleAllEvm}>
                      <Text style={styles.dropdownGroupActionText}>
                        {allEvmSelected ? 'حذف همه' : 'انتخاب همه'}
                      </Text>
                    </Pressable>
                  )}
                </View>
                <Text style={styles.dropdownGroupNote}>{grp.note}</Text>
                <ScrollView
                  nestedScrollEnabled
                  style={styles.dropdownScroll}
                  contentContainerStyle={styles.dropdownScrollContent}
                >
                  {list.map((n) => {
                    const meta = NETWORKS[n];
                    const active = selected.includes(n);
                    return (
                      <Pressable
                        key={n}
                        style={[styles.dropdownRow, active && styles.dropdownRowActive]}
                        onPress={() => toggle(n)}
                        testID={`network-row-${n}`}
                      >
                        <View style={[styles.dropdownRowDot, { backgroundColor: meta.color }]} />
                        <View style={styles.dropdownRowTexts}>
                          <Text style={styles.dropdownRowLabel}>{meta.label}</Text>
                          <Text style={styles.dropdownRowHint}>
                            {meta.addrHint}
                            {meta.wallets ? ` • ${meta.wallets}` : ''}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.checkbox,
                            active && { backgroundColor: colors.dark.accent, borderColor: colors.dark.accent },
                          ]}
                        >
                          {active && <Check size={13} color={colors.dark.background} />}
                        </View>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit wallet form — name / networks dropdown / address + guide
// ---------------------------------------------------------------------------

function AddBlockchainWalletForm({
  editWallet,
  onCancel,
  onSubmit,
}: {
  editWallet?: BlockchainWallet;
  onCancel: () => void;
  onSubmit: (
    name: string,
    networks: BlockchainNetwork[],
    address?: string,
    networkAddresses?: Partial<Record<BlockchainNetwork, string>>
  ) => Promise<boolean>;
}) {
  const [name, setName] = useState(editWallet?.name ?? '');
  const [networks, setNetworks] = useState<BlockchainNetwork[]>(
    editWallet?.networks ?? ['ethereum', 'bsc']
  );
  const [address, setAddress] = useState(editWallet?.address ?? '');
  // v1.4.19 — per-network address overrides (base 0x covers every EVM
  // chain; Filecoin f1 / Solana / TON / Tron / BTC get their OWN input in
  // this same form the moment they're ticked: «در همون قسمت خودش آدرسشو
  // بخواد»).
  const [perNet, setPerNet] = useState<Partial<Record<BlockchainNetwork, string>>>(
    editWallet?.networkAddresses ?? {}
  );
  const [busy, setBusy] = useState(false);

  // v1.5.0 — SPLIT network selection (user demand: «منوی کشویی شبکه‌های
  // مستقل را از قسمت انتخاب شبکه جدا کن و برای آدرس اختصاصی بیار»):
  //  • EVM dropdown  → one shared 0x address (base field)
  //  • standalone dropdown → a DEDICATED address input per selected network,
  //    right below the same dropdown.
  const evmSelected = useMemo(() => networks.filter((n) => isEvmNetwork(n)), [networks]);
  const standaloneSelected = useMemo(() => networks.filter((n) => !isEvmNetwork(n)), [networks]);
  const changeEvm = useCallback((nextEvm: BlockchainNetwork[]) => {
    setNetworks((prev) => [...nextEvm, ...prev.filter((n) => !isEvmNetwork(n))]);
  }, []);
  const changeStandalone = useCallback((nextStandalone: BlockchainNetwork[]) => {
    setNetworks((prev) => [...prev.filter((n) => isEvmNetwork(n)), ...nextStandalone]);
  }, []);

  // networks that need their own address input: every selected NON-EVM
  // network (Filecoin too — its native f1 differs from the FEVM 0x).
  const perNetNetworks = standaloneSelected;

  const validation = useMemo(
    () =>
      (address.trim() || Object.values(perNet).some((v) => v && v.trim().length > 0)) && networks.length > 0
        ? validateAddressForNetworks(networks, (editWallet?.address ?? address).trim(), perNet)
        : null,
    [networks, address, perNet, editWallet]
  );

  const submit = async () => {
    if (busy) return;
    const finalName = name.trim() || `کیف پول ${NETWORKS[networks[0] ?? 'ethereum']?.label ?? 'بلاکچین'}`;
    if (networks.length === 0) {
      ThemedAlert.alert('شبکه انتخاب نشده', 'حداقل یک شبکه از منوی کشویی انتخاب کنید');
      return;
    }
    const baseForCheck = (editWallet?.address ?? address).trim();
    const v = validateAddressForNetworks(networks, baseForCheck, perNet);
    if (!v.ok) {
      ThemedAlert.alert('آدرس نامعتبر', v.message ?? 'آدرس را بررسی کنید');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(
        finalName,
        networks,
        editWallet ? undefined : address.trim(),
        perNet
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.addForm}>
      <Text style={styles.addFormTitle}>
        {editWallet ? 'ویرایش کیف پول بلاکچین' : 'افزودن کیف پول بلاکچین'}
      </Text>
      <View style={styles.readonlyBadge}>
        <Lock size={12} color={colors.dark.green} />
        <Text style={styles.readonlyBadgeText}>
          فقط‌خواندنی — فقط آدرس عمومی، بدون کلید خصوصی
        </Text>
      </View>

      <Text style={styles.inputLabel}>نام کیف پول</Text>
      <TextInput
        style={[styles.input, styles.inputFa]}
        value={name}
        onChangeText={setName}
        placeholder="مثلاً: تراست ولتم — کیف اصلی"
        placeholderTextColor={colors.dark.textMuted}
        maxLength={40}
      />

      {/* ── v1.5.0 — dropdown ۱: شبکه‌های اتریومی (آدرس مشترک 0x) ── */}
      <Text style={styles.inputLabel}>
        شبکه‌های اتریومی (EVM) — همه با یک آدرس 0x{' '}
        {editWallet ? '— با ویرایش شبکه‌ها، موجودی دوباره خوانده می‌شود' : ''}
      </Text>
      <NetworkDropdown selected={evmSelected} onChange={changeEvm} group="evm" />

      {!editWallet && evmSelected.length > 0 && (
        <>
          <Text style={styles.inputLabel}>آدرس عمومی کیف پول (شبکه‌های اتریومی)</Text>
          <TextInput
            style={[styles.input, validation?.ok && styles.inputValid]}
            value={address}
            onChangeText={(t) => setAddress(t.replace(/\s+/g, ''))}
            placeholder={NETWORKS[networks[0] ?? 'ethereum'].addrHint}
            placeholderTextColor={colors.dark.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="default"
            testID="blockchain-address-input"
          />
          {validation && (
            <Text style={[styles.inputHint, validation.ok ? styles.inputHintOk : styles.inputHintErr]}>
              {validation.ok ? '✓ آدرس برای همه شبکه‌های انتخابی معتبر است' : validation.message}
            </Text>
          )}
        </>
      )}

      {/* ── v1.5.0 — dropdown ۲: شبکه‌های مستقل (آدرس اختصاصی جدا) — «منوی
          کشویی شبکه‌های مستقل را از قسمت انتخاب شبکه جدا کن» ── */}
      <View style={{ height: 12 }} />
      <Text style={styles.inputLabel}>
        شبکه‌های مستقل — هر شبکه آدرس اختصاصی خودش (برای آدرس اختصاصی)
      </Text>
      <NetworkDropdown selected={standaloneSelected} onChange={changeStandalone} group="independent" />

      {/* ── v1.5.0 — آدرس اختصاصی هر شبکه مستقل: همین‌جا زیر منوی خودش ── */}
      {perNetNetworks.length > 0 && (
        <View style={styles.perNetBox}>
          <Text style={styles.perNetTitle}>
            آدرس اختصاصی شبکه‌های مستقل انتخاب‌شده
          </Text>
          <Text style={styles.perNetHint}>
            شبکه‌های اتریومی همه با همان آدرس 0x بالا خوانده می‌شوند؛ برای هر شبکه زیر آدرس{' '}
            {editWallet ? 'مخصوص همان شبکه از کیف شما' : 'مخصوص همان شبکه'} را وارد کنید (آدرس
            Receive همان شبکه در تراست ولتم/تون‌کیپر).
          </Text>
          {perNetNetworks.map((n) => {
            const meta = NETWORKS[n];
            const val = perNet[n] ?? '';
            const okNet = val.trim() ? validateBlockchainAddress(n, val.trim()) : null;
            return (
              <View key={n} style={styles.perNetRow}>
                <Text style={styles.perNetLabel}>
                  {meta.label} <Text style={styles.perNetLabelHint}>{meta.addrHint}</Text>
                </Text>
                <TextInput
                  style={[styles.input, okNet && (okNet.ok ? styles.inputValid : styles.inputInvalid)]}
                  value={val}
                  onChangeText={(t) =>
                    setPerNet((p) => ({ ...p, [n]: t.replace(/\s+/g, '') }))
                  }
                  placeholder={meta.wallets ?? meta.label}
                  placeholderTextColor={colors.dark.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {okNet && !okNet.ok && (
                  <Text style={styles.inputHintErr}>{okNet.message}</Text>
                )}
              </View>
            );
          })}
          {editWallet && (
            <Text style={styles.perNetHint}>
              اگر کادر شبکه‌ای را خالی بگذارید و آدرس پایه کیف با آن شبکه سازگار نباشد، ذخیره
              خطا می‌دهد — آدرس همان شبکه را وارد کنید یا آن شبکه را بردارید.
            </Text>
          )}
        </View>
      )}

      {/* ── راهنمای فقط‌خواندنی ── */}
      <View style={styles.guideBox}>
        <View style={styles.guideTitleRow}>
          <Info size={14} color={colors.dark.blue} />
          <Text style={styles.guideTitle}>آدرس فقط‌خواندنی را از تراست ولتم چطور بگیرم؟</Text>
        </View>
        <View style={styles.guideStep}>
          <View style={styles.guideStepNum}>
            <Text style={styles.guideStepNumText}>۱</Text>
          </View>
          <Text style={styles.guideStepText}>
            برنامه <Text style={styles.guideBold}>تراست ولتم</Text> را باز کنید و کیف پول مورد
            نظر را انتخاب کنید.
          </Text>
        </View>
        <View style={styles.guideStep}>
          <View style={styles.guideStepNum}>
            <Text style={styles.guideStepNumText}>۲</Text>
          </View>
          <Text style={styles.guideStepText}>
            آدرس بالای صفحه را <Text style={styles.guideBold}>لمس کنید تا کپی شود</Text> — یا منوی{' '}
            <Text style={styles.guideBold}>⋯ ← View on Block Explorer</Text>.
          </Text>
        </View>
        <View style={styles.guideStep}>
          <View style={styles.guideStepNum}>
            <Text style={styles.guideStepNumText}>۳</Text>
          </View>
          <Text style={styles.guideStepText}>
            برای <Text style={styles.guideBold}>تون (TON)</Text> کیف{' '}
            <Text style={styles.guideBold}>Tonkeeper</Text> را هم می‌توانید اضافه کنید — آدرس
            UQ/EQ آن مستقیماً پذیرفته می‌شود؛ برای سولانا کیف Phantom یا Trust، هر دو base58
            هستند.
          </Text>
        </View>
        <View style={styles.guideStep}>
          <View style={styles.guideStepNum}>
            <Text style={styles.guideStepNumText}>۴</Text>
          </View>
          <Text style={styles.guideStepText}>
            همه شبکه‌های اتریومی (EVM) <Text style={styles.guideBold}>یک آدرس 0x مشترک</Text>{' '}
            دارند — از منوی کشویی هر چند شبکه را که خواستید تیک بزنید؛ فقط شبکه‌های مستقل
            (ترون، تون، بیت‌کوین و…) آدرس جدا می‌خواهند.
          </Text>
        </View>
      </View>

      {/* ── هشدار امنیتی ── */}
      <View style={styles.warnBox}>
        <View style={styles.warnTitleRow}>
          <AlertTriangle size={14} color={colors.dark.red} />
          <Text style={styles.warnTitle}>هشدار امنیتی — خیلی مهم</Text>
        </View>
        <Text style={styles.warnText}>
          هرگز عبارت بازیابی ۱۲ کلمه‌ای یا کلید خصوصی را در هیچ برنامه‌ای (حتی این برنامه) وارد
          نکنید. این بخش فقط آدرس عمومی می‌گیرد؛ خواندن موجودی از بلاکچین عمومی انجام می‌شود و
          هیچ‌کس — از جمله این برنامه — نمی‌تواند از کیف شما برداشت کند.
        </Text>
      </View>

      <View style={styles.formActions}>
        <Pressable
          style={[styles.formBtn, styles.formBtnSave]}
          disabled={busy}
          onPress={() => void submit()}
          testID="blockchain-add-save"
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.dark.background} />
          ) : (
            <>
              <Plus size={16} color={colors.dark.background} />
              <Text style={styles.formBtnSaveText}>
                {editWallet ? 'ذخیره تغییرات' : 'افزودن و نمایش موجودی'}
              </Text>
            </>
          )}
        </Pressable>
        <Pressable style={[styles.formBtn, styles.formBtnCancel]} onPress={onCancel} disabled={busy}>
          <Text style={styles.formBtnCancelText}>انصراف</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Per-wallet card — one summary line (USD + PnL) + expandable tokens
// ---------------------------------------------------------------------------

function BlockchainWalletCard({
  wallet,
  isExpanded,
  data,
  isFetching,
  manualRefreshing,
  error,
  usdtToToman,
  pnlPeriod,
  walletPnl,
  onToggle,
  onRemove,
  onRefresh,
  onEdit,
}: {
  wallet: BlockchainWallet;
  isExpanded: boolean;
  data?: BlockchainWalletData;
  isFetching: boolean;
  /** v1.4.19 — true while the MANUAL per-wallet refresh is running. */
  manualRefreshing: boolean;
  error?: unknown;
  usdtToToman: number;
  pnlPeriod: PnlPeriod;
  walletPnl?: { usdNow: number; usdThen: number; tokens: { label: string; pnl: number; basis: number }[] };
  onToggle: () => void;
  onRemove: () => void;
  onRefresh: () => void;
  onEdit: () => void;
}) {
  const meta = NETWORKS[wallet.networks[0] ?? 'ethereum'];
  const tomanValue = data && usdtToToman > 0 ? data.totalUsd * usdtToToman : 0;
  const pnlUsd = walletPnl ? walletPnl.usdNow - walletPnl.usdThen : 0;
  const pnlPct = walletPnl && walletPnl.usdThen > 0 ? (pnlUsd / walletPnl.usdThen) * 100 : 0;
  const pnlPositive = pnlUsd >= 0;

  return (
    <View style={styles.walletCard}>
      <Pressable style={styles.walletHeader} onPress={onToggle}>
        <View style={[styles.walletAvatar, { backgroundColor: meta.color + '33' }]}>
          <Text style={[styles.walletAvatarText, { color: meta.color }]}>{meta.short}</Text>
        </View>
        <View style={styles.walletNameCol}>
          <Text style={styles.walletName} numberOfLines={1}>
            {wallet.name}
          </Text>
          <Text style={styles.walletAddress}>{shortAddress(wallet.address)}</Text>
          <View style={styles.walletNetChips}>
            {wallet.networks.slice(0, 4).map((n) => (
              <View
                key={n}
                style={[styles.walletNetChip, { backgroundColor: NETWORKS[n].color + '26' }]}
              >
                <Text style={[styles.walletNetChipText, { color: NETWORKS[n].color }]}>
                  {NETWORKS[n].short}
                </Text>
              </View>
            ))}
            {wallet.networks.length > 4 && (
              <View style={[styles.walletNetChip, { backgroundColor: colors.dark.card }]}>
                <Text style={[styles.walletNetChipText, { color: colors.dark.textSecondary }]}>
                  +{(wallet.networks.length - 4).toLocaleString('fa-IR')}
                </Text>
              </View>
            )}
          </View>
        </View>
        <View style={styles.walletTotalCol}>
          {isFetching && !data ? (
            <ActivityIndicator size="small" color={colors.dark.accent} />
          ) : (
            <>
              <Text style={styles.walletTotalUsd}>
                ${data ? data.totalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}
              </Text>
              {tomanValue > 0 && (
                <Text style={styles.walletTotalToman}>{formatToman(tomanValue)} ت</Text>
              )}
              {walletPnl && walletPnl.usdThen > 0 && (
                <Text
                  style={[
                    styles.walletPnlLine,
                    { color: pnlPositive ? colors.dark.green : colors.dark.red },
                  ]}
                >
                  {pnlPositive ? '▲' : '▼'} {Math.abs(pnlUsd).toLocaleString('en-US', {
                    maximumFractionDigits: 2,
                  })}$ ({Math.abs(pnlPct).toLocaleString('fa-IR', {
                    maximumFractionDigits: 1,
                  })}٪ {PNL_PERIOD_LABEL[pnlPeriod]})
                </Text>
              )}
            </>
          )}
        </View>
        <View style={styles.walletActions}>
          <Pressable style={styles.walletIconBtn} onPress={onRemove} hitSlop={8}>
            <Trash2 size={13} color={colors.dark.red} />
          </Pressable>
          <Pressable style={styles.walletIconBtn} onPress={onEdit} hitSlop={8}>
            <Pencil size={13} color={colors.dark.blue} />
          </Pressable>
          <Pressable style={styles.walletIconBtn} onPress={onRefresh} hitSlop={8} disabled={manualRefreshing}>
            {manualRefreshing || isFetching ? (
              <ActivityIndicator size="small" color={colors.dark.accent} />
            ) : (
              <RefreshCw size={13} color={data ? colors.dark.accent : colors.dark.textMuted} />
            )}
          </Pressable>
          {isExpanded ? (
            <ChevronUp size={15} color={colors.dark.textSecondary} />
          ) : (
            <ChevronDown size={15} color={colors.dark.textSecondary} />
          )}
        </View>
      </Pressable>

      {isExpanded && (
        <View style={styles.walletBody}>
          <View style={styles.networkBadgeRow}>
            <Text style={styles.networkBadge}>
              {wallet.networks.length.toLocaleString('fa-IR')} شبکه:{' '}
              {wallet.networks
                .slice(0, 6)
                .map((n) => NETWORKS[n].label)
                .join('، ')}
              {wallet.networks.length > 6 ? ' و…' : ''}
            </Text>
            <Text style={styles.networkBadgeReadonly}>
              <Lock size={9} color={colors.dark.green} /> فقط‌خواندنی
            </Text>
          </View>

          {!data && !!error && (
            <Text style={styles.walletError}>
              دریافت موجودی ناموفق بود — دوباره تلاش کنید (آدرس/شبکه را بررسی کنید)
            </Text>
          )}
          {data && data.tokens.length === 0 && (
            <Text style={styles.walletEmptyText}>
              این آدرس موجودی مثبتی ندارد یا هنوز تراکنشی انجام نداده است
            </Text>
          )}
          {data?.notice && <Text style={styles.walletNotice}>{data.notice}</Text>}

          {data?.tokens.map((t) => {
            const tokenPnl = walletPnl?.tokens.find((x) => x.label === t.symbol);
            return (
              <View key={`${t.symbol}-${t.name}`} style={styles.tokenRow}>
                <View style={[styles.tokenIcon, { backgroundColor: (t.network ? NETWORKS[t.network].color : meta.color) + '26' }]}>
                  <Text
                    style={[
                      styles.tokenIconText,
                      { color: t.network ? NETWORKS[t.network].color : meta.color },
                    ]}
                  >
                    {t.symbol.slice(0, 1)}
                  </Text>
                </View>
                <View style={styles.tokenMain}>
                  <Text style={styles.tokenSymbol}>
                    {t.symbol}
                    {t.network && wallet.networks.length > 1 ? (
                      <Text style={styles.tokenNetTag}> ({NETWORKS[t.network].short})</Text>
                    ) : null}
                  </Text>
                  <Text style={styles.tokenName} numberOfLines={1}>
                    {t.name}
                  </Text>
                  {tokenPnl && (
                    <Text
                      style={[
                        styles.tokenPnl,
                        { color: tokenPnl.pnl >= 0 ? colors.dark.green : colors.dark.red },
                      ]}
                    >
                      {PNL_PERIOD_LABEL[pnlPeriod]}: {tokenPnl.pnl >= 0 ? '+' : '−'} $
                      {Math.abs(tokenPnl.pnl).toLocaleString('en-US', {
                        maximumFractionDigits: 2,
                      })}
                    </Text>
                  )}
                </View>
                <Text style={styles.tokenQty}>
                  {t.qty.toLocaleString('en-US', {
                    maximumFractionDigits: t.qty < 1 ? 8 : 4,
                  })}
                </Text>
                <View style={styles.tokenValueCol}>
                  <Text style={styles.tokenValue}>
                    {t.priceUsd > 0
                      ? `$${t.valueUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                      : 'قیمت نامشخص'}
                  </Text>
                  {t.change24hPct !== null && t.change24hPct !== undefined && (
                    <Text
                      style={[
                        styles.tokenChange,
                        { color: (t.change24hPct ?? 0) >= 0 ? colors.dark.green : colors.dark.red },
                      ]}
                    >
                      {(t.change24hPct ?? 0) >= 0 ? '▲' : '▼'}{' '}
                      {Math.abs(t.change24hPct ?? 0).toLocaleString('fa-IR', {
                        maximumFractionDigits: 2,
                      })}٪
                    </Text>
                  )}
                </View>
              </View>
            );
          })}

          {data && (
            <Text style={styles.walletFetchedAt}>
              آخرین دریافت: {new Date(data.fetchedAt).toLocaleTimeString('fa-IR')} •{' '}
              {data.tokens.length.toLocaleString('fa-IR')} دارایی
            </Text>
          )}

          <View style={styles.lockNote}>
            <Lock size={11} color={colors.dark.green} />
            <Text style={styles.lockNoteText}>
              آدرس عمومی در حافظه دستگاه ذخیره می‌شود — امکان برداشت وجود ندارد
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const styles = createThemedStyles(() =>
  StyleSheet.create({
    portfolioCard: {
      backgroundColor: colors.dark.surface,
      borderRadius: 16,
      padding: 20,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.dark.accent + '33',
    },
    portfolioHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 12,
    },
    portfolioTitle: {
      fontSize: 14,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
      flex: 1,
      textAlign: 'right',
    },
    refreshAllBtn: {
      padding: 6,
      borderRadius: 8,
      backgroundColor: colors.dark.accentDim,
    },
    portfolioValues: {
      gap: 8,
      marginBottom: 10,
    },
    portfolioValueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.dark.card,
      padding: 10,
      borderRadius: 10,
    },
    portfolioValueLabel: {
      fontSize: 12,
      color: colors.dark.textSecondary,
    },
    portfolioValueAmount: {
      flex: 1,
      textAlign: 'left',
      fontSize: 15,
      fontWeight: '700' as const,
      color: colors.dark.green,
    },
    tomanPriceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.dark.surfaceLight,
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 12,
      marginBottom: 6,
    },
    tomanPriceLabel: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.text,
    },
    tomanPriceValue: {
      fontSize: 16,
      fontWeight: '800' as const,
      color: colors.dark.accent,
    },
    portfolioSub: {
      fontSize: 10.5,
      color: colors.dark.textMuted,
      marginTop: 9,
      textAlign: 'right',
    },

    // ── VPN gate card ──
    vpnGateCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.dark.redDim,
      borderWidth: 1,
      borderColor: colors.dark.red + '40',
      borderRadius: 14,
      padding: 14,
      marginBottom: 14,
    },
    vpnGateTexts: {
      flex: 1,
      gap: 3,
    },
    vpnGateTitle: {
      fontSize: 12.5,
      fontWeight: '700' as const,
      color: colors.dark.red,
    },
    vpnGateSub: {
      fontSize: 10,
      lineHeight: 16,
      color: colors.dark.textSecondary,
    },
    vpnGateBtn: {
      padding: 8,
      borderRadius: 10,
      backgroundColor: colors.dark.red + '18',
    },

    // ── add form ──
    addForm: {
      backgroundColor: colors.dark.surface,
      borderRadius: 16,
      padding: 18,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    addFormTitle: {
      fontSize: 15,
      fontWeight: '700' as const,
      color: colors.dark.text,
      textAlign: 'right',
      marginBottom: 8,
    },
    readonlyBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      backgroundColor: colors.dark.greenDim,
      borderRadius: 9,
      paddingHorizontal: 10,
      paddingVertical: 5,
      marginBottom: 12,
    },
    readonlyBadgeText: {
      fontSize: 10,
      fontWeight: '700' as const,
      color: colors.dark.green,
    },
    inputLabel: {
      fontSize: 11.5,
      fontWeight: '700' as const,
      color: colors.dark.textSecondary,
      marginTop: 10,
      marginBottom: 6,
      textAlign: 'right',
    },
    input: {
      backgroundColor: colors.dark.surfaceLight,
      borderWidth: 1,
      borderColor: colors.dark.border,
      borderRadius: 10,
      color: colors.dark.text,
      fontSize: 13,
      fontWeight: '600' as const,
      paddingHorizontal: 12,
      paddingVertical: 10,
      textAlign: 'left',
    },
    inputFa: {
      textAlign: 'right',
    },
    inputValid: {
      borderColor: colors.dark.green + '66',
    },
    inputInvalid: {
      borderColor: colors.dark.red + '66',
    },
    // ── v1.4.19 — per-network address inputs + refresh toast ──
    perNetBox: {
      marginTop: 8,
      padding: 10,
      borderRadius: 10,
      backgroundColor: colors.dark.surface,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    perNetTitle: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.dark.textSecondary,
      textAlign: 'right',
      marginBottom: 3,
    },
    perNetHint: {
      fontSize: 9,
      color: colors.dark.textMuted,
      textAlign: 'right',
      lineHeight: 14,
      marginBottom: 4,
    },
    perNetRow: {
      marginTop: 6,
    },
    perNetLabel: {
      fontSize: 10,
      fontWeight: '600',
      color: colors.dark.textSecondary,
      textAlign: 'right',
      marginBottom: 3,
    },
    perNetLabelHint: {
      fontSize: 8.5,
      fontWeight: '400',
      color: colors.dark.textMuted,
    },
    refreshToast: {
      marginTop: 10,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: colors.dark.accent + '1C',
      borderWidth: 1,
      borderColor: colors.dark.accent + '55',
      alignItems: 'center',
    },
    refreshToastText: {
      fontSize: 10,
      color: colors.dark.accent,
      fontWeight: '600',
    },
    inputHint: {
      fontSize: 9.5,
      marginTop: 5,
      textAlign: 'right',
    },
    inputHintOk: {
      color: colors.dark.green,
    },
    inputHintErr: {
      color: colors.dark.red,
    },

    // ── network dropdown (v1.4.17 «منوی کشویی شبکه‌ها») ──
    dropdownBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.dark.surfaceLight,
      borderWidth: 1,
      borderColor: colors.dark.accent + '55',
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    dropdownBtnLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      flex: 1,
    },
    dropdownDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    dropdownBtnText: {
      fontSize: 12.5,
      fontWeight: '700' as const,
      color: colors.dark.text,
      marginRight: 8,
    },
    dropdownPanel: {
      marginTop: 8,
      backgroundColor: colors.dark.card,
      borderWidth: 1,
      borderColor: colors.dark.border,
      borderRadius: 12,
      padding: 10,
    },
    dropdownSearch: {
      backgroundColor: colors.dark.surfaceLight,
      borderWidth: 1,
      borderColor: colors.dark.border,
      borderRadius: 8,
      color: colors.dark.text,
      fontSize: 12,
      paddingHorizontal: 10,
      paddingVertical: 7,
      textAlign: 'right',
      marginBottom: 8,
    },
    dropdownGroup: {
      marginBottom: 10,
    },
    dropdownGroupHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 3,
    },
    dropdownGroupTitle: {
      fontSize: 11.5,
      fontWeight: '800' as const,
      color: colors.dark.accent,
      textAlign: 'right',
    },
    dropdownGroupAction: {
      padding: 4,
      borderRadius: 6,
      backgroundColor: colors.dark.accentDim,
    },
    dropdownGroupActionText: {
      fontSize: 10,
      fontWeight: '700' as const,
      color: colors.dark.accent,
    },
    dropdownGroupNote: {
      fontSize: 9,
      lineHeight: 14,
      color: colors.dark.textMuted,
      textAlign: 'right',
      marginBottom: 6,
    },
    dropdownScroll: {
      maxHeight: 260,
    },
    dropdownScrollContent: {
      paddingBottom: 4,
    },
    dropdownRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 7,
      paddingHorizontal: 8,
      borderRadius: 8,
      marginBottom: 2,
      backgroundColor: colors.dark.surfaceLight,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    dropdownRowActive: {
      borderColor: colors.dark.accent + '66',
      backgroundColor: colors.dark.accent + '14',
    },
    dropdownRowDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    dropdownRowTexts: {
      flex: 1,
      gap: 1,
    },
    dropdownRowLabel: {
      fontSize: 11.5,
      fontWeight: '700' as const,
      color: colors.dark.text,
      textAlign: 'right',
    },
    dropdownRowHint: {
      fontSize: 9,
      color: colors.dark.textMuted,
      textAlign: 'right',
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: colors.dark.border,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── guide + warning ──
    guideBox: {
      backgroundColor: colors.dark.blue + '10',
      borderWidth: 1,
      borderColor: colors.dark.blue + '30',
      borderRadius: 12,
      padding: 12,
      marginTop: 14,
    },
    guideTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 8,
    },
    guideTitle: {
      fontSize: 11.5,
      fontWeight: '800' as const,
      color: colors.dark.blue,
      flex: 1,
      textAlign: 'right',
    },
    guideStep: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 8,
    },
    guideStepNum: {
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: colors.dark.blue + '26',
      alignItems: 'center',
      justifyContent: 'center',
    },
    guideStepNumText: {
      fontSize: 9.5,
      fontWeight: '800' as const,
      color: colors.dark.blue,
    },
    guideStepText: {
      flex: 1,
      fontSize: 10,
      lineHeight: 16,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    guideBold: {
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    warnBox: {
      backgroundColor: colors.dark.redDim,
      borderWidth: 1,
      borderColor: colors.dark.red + '40',
      borderRadius: 12,
      padding: 12,
      marginTop: 10,
    },
    warnTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 6,
    },
    warnTitle: {
      fontSize: 11.5,
      fontWeight: '800' as const,
      color: colors.dark.red,
      flex: 1,
      textAlign: 'right',
    },
    warnText: {
      fontSize: 10,
      lineHeight: 16,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    formActions: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 14,
    },
    formBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    formBtnSave: {
      flex: 1,
      backgroundColor: colors.dark.accent,
    },
    formBtnSaveText: {
      fontSize: 12,
      fontWeight: '800' as const,
      color: colors.dark.background,
    },
    formBtnCancel: {
      paddingHorizontal: 16,
      backgroundColor: colors.dark.surfaceLight,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    formBtnCancelText: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.textSecondary,
    },

    // ── wallet card ──
    walletCard: {
      backgroundColor: colors.dark.surface,
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    walletHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    walletAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    walletAvatarText: {
      fontSize: 10,
      fontWeight: '800' as const,
    },
    walletNameCol: {
      flex: 1,
      gap: 2,
    },
    walletName: {
      fontSize: 13,
      fontWeight: '700' as const,
      color: colors.dark.text,
    },
    walletAddress: {
      fontSize: 10,
      color: colors.dark.textMuted,
    },
    walletNetChips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 3,
      marginTop: 2,
    },
    walletNetChip: {
      borderRadius: 5,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    walletNetChipText: {
      fontSize: 8.5,
      fontWeight: '800' as const,
    },
    walletTotalCol: {
      alignItems: 'flex-end',
      gap: 2,
      maxWidth: 130,
    },
    walletTotalUsd: {
      fontSize: 13,
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    walletTotalToman: {
      fontSize: 10,
      color: colors.dark.textSecondary,
    },
    walletPnlLine: {
      fontSize: 9.5,
      fontWeight: '800' as const,
      textAlign: 'left',
    },
    walletActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    walletIconBtn: {
      padding: 5,
      borderRadius: 8,
      backgroundColor: colors.dark.surfaceLight,
    },
    walletBody: {
      marginTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.dark.border,
      paddingTop: 10,
    },
    networkBadgeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginBottom: 8,
    },
    networkBadge: {
      fontSize: 9.5,
      fontWeight: '700' as const,
      color: colors.dark.textSecondary,
      flex: 1,
      textAlign: 'right',
    },
    networkBadgeReadonly: {
      fontSize: 9,
      fontWeight: '700' as const,
      color: colors.dark.green,
    },
    walletError: {
      fontSize: 10.5,
      color: colors.dark.red,
      textAlign: 'right',
      marginBottom: 8,
    },
    walletNotice: {
      fontSize: 9,
      color: colors.dark.orange ?? '#F7931A',
      textAlign: 'right',
      marginBottom: 6,
    },
    walletEmptyText: {
      fontSize: 10.5,
      color: colors.dark.textMuted,
      textAlign: 'right',
      paddingVertical: 8,
    },
    tokenRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 7,
      borderBottomWidth: 1,
      borderBottomColor: colors.dark.border + '66',
    },
    tokenIcon: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tokenIconText: {
      fontSize: 11,
      fontWeight: '800' as const,
    },
    tokenMain: {
      flex: 1,
      gap: 1,
    },
    tokenSymbol: {
      fontSize: 11.5,
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    tokenNetTag: {
      fontSize: 8.5,
      color: colors.dark.textMuted,
    },
    tokenName: {
      fontSize: 9,
      color: colors.dark.textMuted,
    },
    tokenPnl: {
      fontSize: 9,
      fontWeight: '700' as const,
    },
    tokenQty: {
      fontSize: 10,
      color: colors.dark.textSecondary,
      minWidth: 60,
      textAlign: 'left',
    },
    tokenValueCol: {
      alignItems: 'flex-end',
      minWidth: 70,
    },
    tokenValue: {
      fontSize: 11,
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    tokenChange: {
      fontSize: 9,
      fontWeight: '700' as const,
    },
    walletFetchedAt: {
      fontSize: 9,
      color: colors.dark.textMuted,
      textAlign: 'right',
      marginTop: 8,
    },
    lockNote: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 8,
      backgroundColor: colors.dark.greenDim,
      borderRadius: 8,
      padding: 8,
    },
    lockNoteText: {
      flex: 1,
      fontSize: 9,
      color: colors.dark.green,
      textAlign: 'right',
    },

    // ── PnL box ──
    pnlBox: {
      backgroundColor: colors.dark.card,
      borderRadius: 12,
      padding: 12,
      marginTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.dark.border,
    },
    pnlHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 8,
    },
    pnlTitle: {
      fontSize: 11,
      fontWeight: '700' as const,
      color: colors.dark.textSecondary,
      flex: 1,
      textAlign: 'right',
    },
    pnlPeriodRow: {
      flexDirection: 'row',
      gap: 5,
      marginBottom: 10,
    },
    pnlPeriodChip: {
      borderRadius: 8,
      paddingHorizontal: 9,
      paddingVertical: 4,
      backgroundColor: colors.dark.surfaceLight,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    pnlPeriodChipActive: {
      backgroundColor: colors.dark.accent,
      borderColor: colors.dark.accent,
    },
    pnlPeriodText: {
      fontSize: 10,
      fontWeight: '700' as const,
      color: colors.dark.textSecondary,
    },
    pnlPeriodTextActive: {
      color: colors.dark.background,
    },
    pnlLoading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
    },
    pnlLoadingText: {
      fontSize: 10.5,
      color: colors.dark.textMuted,
    },
    pnlEmpty: {
      fontSize: 10,
      color: colors.dark.textMuted,
      textAlign: 'right',
      paddingVertical: 8,
    },
    pnlTotal: {
      fontSize: 19,
      fontWeight: '800' as const,
      textAlign: 'left',
    },
    pnlPctRow: {
      flexDirection: 'row',
      marginTop: 6,
      marginBottom: 4,
    },
    pnlPctChip: {
      backgroundColor: colors.dark.green + '1C',
      borderRadius: 8,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    pnlPctText: {
      fontSize: 10,
      fontWeight: '800' as const,
      color: colors.dark.green,
    },
    pnlToman: {
      fontSize: 11,
      fontWeight: '700' as const,
      textAlign: 'right',
      marginTop: 2,
      marginBottom: 6,
    },
    pnlRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 4,
      borderBottomWidth: 1,
      borderBottomColor: colors.dark.border + '66',
    },
    pnlRowLabel: {
      fontSize: 10.5,
      fontWeight: '700' as const,
      color: colors.dark.text,
    },
    pnlRowValue: {
      fontSize: 10.5,
      fontWeight: '800' as const,
    },
    pnlNote: {
      fontSize: 8.5,
      lineHeight: 13,
      color: colors.dark.textMuted,
      textAlign: 'right',
      marginTop: 8,
    },

    // ── empty state + add button ──
    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.dark.accent + '1A',
      borderWidth: 1,
      borderColor: colors.dark.accent + '55',
      borderRadius: 12,
      paddingVertical: 12,
      marginBottom: 12,
    },
    addButtonText: {
      fontSize: 12.5,
      fontWeight: '800' as const,
      color: colors.dark.accent,
    },
    emptyState: {
      alignItems: 'center',
      padding: 24,
      backgroundColor: colors.dark.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.dark.border,
      gap: 10,
    },
    emptyTitle: {
      fontSize: 13,
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    emptySubtitle: {
      fontSize: 10.5,
      lineHeight: 17,
      color: colors.dark.textMuted,
      textAlign: 'center',
    },
  })
);
