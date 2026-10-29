import AsyncStorage from '@react-native-async-storage/async-storage';
import CryptoJS from 'crypto-js';
import { blake2b, blake2b8Hex, blake2b256Hex } from './blake2b';

/**
 * blockchainWallets.ts — v1.4.17
 *
 * Types + storage for the «کیف پول بلاکچین (فقط خواندنی)» 4th tab.
 *
 * A blockchain wallet entry is NOTHING but a PUBLIC address + the list of
 * networks it is tracked on — no private key, no seed phrase, no credentials.
 * Balances are read from public keyless explorers/RPCs (blockchainWalletApi).
 *
 * v1.4.17 — MULTI-NETWORK wallets:
 *   • One wallet = ONE public address tracked on MANY networks at once
 *     (all EVM chains share the same 0x address, so ticking Ethereum + BSC +
 *     Avalanche + … reads the same address on every selected chain).
 *   • The network picker is a collapsible multi-select list («منوی کشویی»)
 *     with a manual check-mark per network — the user asked for every
 *     Trust-Wallet-supported network to be listed.
 *   • `networks: BlockchainNetwork[]` replaces the old single `network`
 *     field; loading migrates old entries automatically.
 *
 * Every endpoint used by the fetchers in blockchainWalletApi.ts was
 * live-verified keyless before this release (see scripts/live-test-v1417*.mjs).
 */

export type BlockchainNetwork =
  // ── EVM family (one 0x address works on all of them) ──
  | 'ethereum'
  | 'bsc'
  | 'polygon'
  | 'arbitrum'
  | 'base'
  | 'optimism'
  | 'avalanche'
  | 'fantom'
  | 'zksync'
  | 'linea'
  | 'mantle'
  | 'opbnb'
  | 'scroll'
  | 'blast'
  | 'gnosis'
  | 'celo'
  | 'cronos'
  | 'moonbeam'
  | 'moonriver'
  | 'aurora'
  | 'harmony'
  | 'kcc'
  | 'fuse'
  | 'xdc'
  | 'zora'
  | 'polygon-zkevm'
  | 'immutable'
  | 'sonic'
  // ── independent networks (each has its own address format) ──
  | 'filecoin'
  | 'solana'
  | 'ton'
  | 'tron'
  | 'bitcoin'
  | 'litecoin'
  | 'dogecoin'
  | 'bitcoin-cash'
  | 'xrp'
  | 'cardano'
  | 'polkadot'
  | 'cosmos'
  | 'near'
  | 'aptos'
  | 'sui'
  | 'stellar'
  | 'algorand'
  | 'tezos'
  | 'multiversx'
  | 'hedera'
  | 'zilliqa'
  | 'vechain'
  | 'kaspa';

export interface BlockchainWallet {
  id: string;
  /** User-chosen display name, e.g. «تراست ولتم — کیف اصلی». */
  name: string;
  /** v1.4.17 — the networks this address is tracked on (multi-select). */
  networks: BlockchainNetwork[];
  /** PUBLIC address only — safe to store, impossible to withdraw from. */
  address: string;
  /**
   * v1.4.19 — per-network address overrides. The BASE `address` works for
   * every EVM chain (same 0x) — but a wallet can ALSO carry a Filecoin f1
   * address, a Solana address, a TON (Tonkeeper) address … each one is
   * asked for in the SAME add/edit form the moment that network is ticked
   * («در همون قسمت خودش آدرسشو بخواد») and used only for that network.
   * PUBLIC addresses only — read-only, same as `address`.
   */
  networkAddresses?: Partial<Record<BlockchainNetwork, string>>;
  addedAt: number;
}

/** One held asset of a blockchain wallet (native coin or token). */
export interface BlockchainTokenBalance {
  /** Display symbol: ETH, USDT, BNB, SOL, TRX … */
  symbol: string;
  /** Persian/English display name. */
  name: string;
  kind: 'native' | 'token';
  qty: number;
  /** Resolved USD price (0 = unknown — the row is STILL shown). */
  priceUsd: number;
  /** 24h price change percent (null = unknown). */
  change24hPct: number | null;
  valueUsd: number;
  /** Binance pair for the price (ETHUSDT…) — used for PnL history. */
  binancePair?: string;
  /** CoinGecko id (fallback price/history source). */
  coingeckoId?: string;
  /** v1.2.0 — URL آیکون واقعی ارز (CoinGecko assets)؛ خالی = آواتار حرفی. */
  icon?: string;
  /** v1.4.17 — which network this row was read from (multi-network wallets). */
  network?: BlockchainNetwork;
}

export interface BlockchainWalletData {
  walletId: string;
  tokens: BlockchainTokenBalance[];
  totalUsd: number;
  fetchedAt: number;
  /** Non-fatal fetch issue (partial data) — shown under the wallet card. */
  notice?: string;
}

// ---------------------------------------------------------------------------
// Network metadata
// ---------------------------------------------------------------------------

export interface NetworkMeta {
  id: BlockchainNetwork;
  /** Persian label used in chips / pickers. */
  label: string;
  /** Short label for tight chips. */
  short: string;
  /** Native coin symbol. */
  native: string;
  /** Circle-avatar color. */
  color: string;
  /** Public RPC endpoints (JSON-RPC, keyless) — EVM + a few others. */
  rpcs: string[];
  /** Blockscout API v2 root (EVM only) — primary full-discovery path. */
  blockscout?: string;
  /** CoinGecko platform id — token registry + contract prices. */
  cgPlatform?: string;
  /** Trust Wallet tokenlist dir (blockchains/<dir>/tokenlist.json). */
  twList?: string;
  /** Address hint shown in the picker. */
  addrHint: string;
  /** Wallet apps known for this network (shown under the dropdown). */
  wallets?: string;
}

const B58 = '[1-9A-HJ-NP-Za-km-z]';

export const NETWORKS: Record<BlockchainNetwork, NetworkMeta> = {
  ethereum: {
    id: 'ethereum', label: 'اتریوم', short: 'ETH', native: 'ETH', color: '#627EEA',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com', 'https://rpc.ankr.com/eth'],
    blockscout: 'https://eth.blockscout.com', cgPlatform: 'ethereum', twList: 'ethereum',
    addrHint: 'ETH • 0x…', wallets: 'Trust / MetaMask / Ledger',
  },
  bsc: {
    id: 'bsc', label: 'BNB Chain (اسمارت‌چین)', short: 'BNB', native: 'BNB', color: '#F0B90B',
    rpcs: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io'],
    cgPlatform: 'binance-smart-chain', twList: 'smartchain',
    addrHint: 'BSC • 0x…', wallets: 'Trust / MetaMask / Binance Wallet',
  },
  polygon: {
    id: 'polygon', label: 'پالیگان', short: 'POL', native: 'POL', color: '#8247E5',
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://rpc.ankr.com/polygon'],
    blockscout: 'https://polygon.blockscout.com', cgPlatform: 'polygon-pos', twList: 'polygon',
    addrHint: 'POL • 0x…',
  },
  arbitrum: {
    id: 'arbitrum', label: 'آربیتروم', short: 'ARB', native: 'ETH', color: '#28A0F0',
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-rpc.publicnode.com'],
    blockscout: 'https://arbitrum.blockscout.com', cgPlatform: 'arbitrum-one', twList: 'arbitrum',
    addrHint: 'ARB • 0x…',
  },
  base: {
    id: 'base', label: 'بیس (Base)', short: 'BASE', native: 'ETH', color: '#0052FF',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    blockscout: 'https://base.blockscout.com', cgPlatform: 'base', twList: 'base',
    addrHint: 'BASE • 0x…',
  },
  optimism: {
    id: 'optimism', label: 'اوپتیمیزم', short: 'OP', native: 'ETH', color: '#FF0420',
    rpcs: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    blockscout: 'https://optimism.blockscout.com', cgPlatform: 'optimistic-ethereum', twList: 'optimism',
    addrHint: 'OP • 0x…',
  },
  avalanche: {
    id: 'avalanche', label: 'آوالانچ (C-Chain)', short: 'AVAX', native: 'AVAX', color: '#E84142',
    rpcs: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
    cgPlatform: 'avalanche', twList: 'avalanche',
    addrHint: 'AVAX • 0x…',
  },
  fantom: {
    id: 'fantom', label: 'فانتوم', short: 'FTM', native: 'FTM', color: '#1969FF',
    rpcs: ['https://rpc.fantom.network', 'https://rpcapi.fantom.network'],
    cgPlatform: 'fantom', twList: 'fantom',
    addrHint: 'FTM • 0x…',
  },
  zksync: {
    id: 'zksync', label: 'zkSync Era', short: 'ZK', native: 'ETH', color: '#8C8DFC',
    rpcs: ['https://mainnet.era.zksync.io'],
    blockscout: 'https://zksync.blockscout.com', cgPlatform: 'zksync', twList: 'zksync',
    addrHint: 'ZK • 0x…',
  },
  linea: {
    id: 'linea', label: 'لینئا', short: 'LINEA', native: 'ETH', color: '#61DFFF',
    rpcs: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'],
    cgPlatform: 'linea', twList: 'linea',
    addrHint: 'LINEA • 0x…',
  },
  mantle: {
    id: 'mantle', label: 'منتل', short: 'MNT', native: 'MNT', color: '#74FB9B',
    rpcs: ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com'],
    cgPlatform: 'mantle',
    addrHint: 'MNT • 0x…',
  },
  opbnb: {
    id: 'opbnb', label: 'opBNB', short: 'OPBNB', native: 'BNB', color: '#F0B90B',
    rpcs: ['https://opbnb-rpc.publicnode.com', 'https://opbnb.drpc.org'],
    cgPlatform: 'op-bnb',
    addrHint: 'opBNB • 0x…',
  },
  scroll: {
    id: 'scroll', label: 'اسکرول', short: 'SCROLL', native: 'ETH', color: '#EAEAEA',
    rpcs: ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com'],
    blockscout: 'https://scroll.blockscout.com', cgPlatform: 'scroll',
    addrHint: 'SCROLL • 0x…',
  },
  blast: {
    id: 'blast', label: 'بلاست', short: 'BLAST', native: 'ETH', color: '#FCFC03',
    rpcs: ['https://rpc.blast.io', 'https://blast-rpc.publicnode.com'],
    cgPlatform: 'blast',
    addrHint: 'BLAST • 0x…',
  },
  gnosis: {
    id: 'gnosis', label: 'گنوزیس', short: 'GNO', native: 'XDAI', color: '#48A9A6',
    rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'],
    blockscout: 'https://gnosis.blockscout.com', cgPlatform: 'gnosis',
    addrHint: 'GNO • 0x…',
  },
  celo: {
    id: 'celo', label: 'سلُ', short: 'CELO', native: 'CELO', color: '#FBCC5C',
    rpcs: ['https://forno.celo.org', 'https://celo-rpc.publicnode.com'],
    blockscout: 'https://celo.blockscout.com', cgPlatform: 'celo',
    addrHint: 'CELO • 0x…',
  },
  cronos: {
    id: 'cronos', label: 'کرونوس', short: 'CRO', native: 'CRO', color: '#002D74',
    rpcs: ['https://evm.cronos.org', 'https://cronos.drpc.org'],
    cgPlatform: 'cronos',
    addrHint: 'CRO • 0x…',
  },
  moonbeam: {
    id: 'moonbeam', label: 'مون‌بیم', short: 'GLMR', native: 'GLMR', color: '#8A2BE2',
    rpcs: ['https://rpc.api.moonbeam.network'],
    cgPlatform: 'moonbeam',
    addrHint: 'GLMR • 0x…',
  },
  moonriver: {
    id: 'moonriver', label: 'مون‌ریور', short: 'MOVR', native: 'MOVR', color: '#FFB300',
    rpcs: ['https://rpc.api.moonriver.network'],
    cgPlatform: 'moonriver',
    addrHint: 'MOVR • 0x…',
  },
  aurora: {
    id: 'aurora', label: 'آرورا', short: 'AURORA', native: 'ETH', color: '#2EC9C9',
    rpcs: ['https://mainnet.aurora.dev'],
    cgPlatform: 'aurora',
    addrHint: 'AURORA • 0x…',
  },
  harmony: {
    id: 'harmony', label: 'هارمونی', short: 'ONE', native: 'ONE', color: '#0090FF',
    rpcs: ['https://api.harmony.one'],
    cgPlatform: 'harmony-shard-0',
    addrHint: 'ONE • 0x…',
  },
  kcc: {
    id: 'kcc', label: 'KCC', short: 'KCS', native: 'KCS', color: '#31A5FF',
    rpcs: ['https://rpc-mainnet.kcc.network'],
    cgPlatform: 'kcc',
    addrHint: 'KCC • 0x…',
  },
  fuse: {
    id: 'fuse', label: 'فیوز', short: 'FUSE', native: 'FUSE', color: '#2FBF71',
    rpcs: ['https://rpc.fuse.io'],
    cgPlatform: 'fuse',
    addrHint: 'FUSE • 0x…',
  },
  xdc: {
    id: 'xdc', label: 'XDC', short: 'XDC', native: 'XDC', color: '#3E5FE0',
    rpcs: ['https://rpc.xinfin.network'],
    cgPlatform: 'xdc-network',
    addrHint: 'XDC • 0x…',
  },
  zora: {
    id: 'zora', label: 'زورا', short: 'ZORA', native: 'ETH', color: '#949494',
    rpcs: ['https://rpc.zora.energy', 'https://zora-rpc.publicnode.com'],
    cgPlatform: 'zora-evm',
    addrHint: 'ZORA • 0x…',
  },
  'polygon-zkevm': {
    id: 'polygon-zkevm', label: 'پالیگان zkEVM', short: 'ZKEVM', native: 'ETH', color: '#8C8DFC',
    rpcs: ['https://zkevm-rpc.com'],
    cgPlatform: 'polygon-zkevm',
    addrHint: 'ZKEVM • 0x…',
  },
  immutable: {
    id: 'immutable', label: 'Immutable zkEVM', short: 'IMX', native: 'IMX', color: '#1FD0EF',
    rpcs: ['https://rpc.immutable.com'],
    cgPlatform: 'immutable',
    addrHint: 'IMX • 0x…',
  },
  sonic: {
    id: 'sonic', label: 'سونیک', short: 'S', native: 'S', color: '#9C5BF5',
    rpcs: ['https://rpc.soniclabs.com', 'https://sonic-rpc.publicnode.com'],
    cgPlatform: 'sonic', twList: 'sonic',
    addrHint: 'SONIC • 0x…',
  },
  filecoin: {
    id: 'filecoin', label: 'فایل‌کوین', short: 'FIL', native: 'FIL', color: '#42C1CA',
    rpcs: ['https://api.node.glif.io/rpc/v1'],
    blockscout: 'https://filecoin.blockscout.com', cgPlatform: 'filecoin',
    addrHint: 'FIL • f1… / 0x…', wallets: 'Trust / Ledger / Glif',
  },
  solana: {
    id: 'solana', label: 'سولانا', short: 'SOL', native: 'SOL', color: '#9945FF',
    rpcs: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.com'],
    addrHint: 'SOL • base58 (۴۴ کاراکتر)', wallets: 'Trust / Phantom / Solflare',
  },
  ton: {
    id: 'ton', label: 'تون (TON)', short: 'TON', native: 'TON', color: '#37A8DB',
    rpcs: ['https://toncenter.com'],
    addrHint: 'TON • UQ… / EQ… (۴۸ کاراکتر)', wallets: 'Tonkeeper / Trust / MyTonWallet',
  },
  tron: {
    id: 'tron', label: 'ترون', short: 'TRON', native: 'TRX', color: '#E84142',
    rpcs: ['https://api.trongrid.io'],
    addrHint: 'TRON • T…', wallets: 'Trust / TronLink',
  },
  bitcoin: {
    id: 'bitcoin', label: 'بیت‌کوین', short: 'BTC', native: 'BTC', color: '#F7931A',
    rpcs: [],
    addrHint: 'BTC • bc1… / 1… / 3…',
  },
  litecoin: {
    id: 'litecoin', label: 'لایت‌کوین', short: 'LTC', native: 'LTC', color: '#A6A9AA',
    rpcs: [],
    addrHint: 'LTC • ltc1… / L… / M…',
  },
  dogecoin: {
    id: 'dogecoin', label: 'دوج‌کوین', short: 'DOGE', native: 'DOGE', color: '#C3A634',
    rpcs: [],
    addrHint: 'DOGE • D…',
  },
  'bitcoin-cash': {
    id: 'bitcoin-cash', label: 'بیت‌کوین کش', short: 'BCH', native: 'BCH', color: '#8DC351',
    rpcs: [],
    addrHint: 'BCH • bitcoincash:q… / q… / 1…',
  },
  xrp: {
    id: 'xrp', label: 'ریپل (XRP)', short: 'XRP', native: 'XRP', color: '#25A0E0',
    rpcs: ['https://xrplcluster.com'],
    addrHint: 'XRP • r…', wallets: 'Trust / Xaman (XRP Ledger)',
  },
  cardano: {
    id: 'cardano', label: 'کاردانو', short: 'ADA', native: 'ADA', color: '#0033AD',
    rpcs: ['https://api.koios.rest'],
    addrHint: 'ADA • addr1…', wallets: 'Trust / Lace / Daedalus',
  },
  polkadot: {
    id: 'polkadot', label: 'پولکادات', short: 'DOT', native: 'DOT', color: '#E6007A',
    rpcs: ['https://rpc.polkadot.io'],
    addrHint: 'DOT • 1… (۴۷ کاراکتر)', wallets: 'Trust / Polkadot.js / Talisman',
  },
  cosmos: {
    id: 'cosmos', label: 'کازموس هاب', short: 'ATOM', native: 'ATOM', color: '#5064FB',
    rpcs: ['https://cosmos-rest.publicnode.com'],
    addrHint: 'ATOM • cosmos1…', wallets: 'Trust / Keplr / Cosmostation',
  },
  near: {
    id: 'near', label: 'نیر', short: 'NEAR', native: 'NEAR', color: '#00C08B',
    rpcs: ['https://rpc.mainnet.near.org'],
    addrHint: 'NEAR • نام حساب (مثل wallet.near) یا 0x…', wallets: 'Trust / Meteor / Sender',
  },
  aptos: {
    id: 'aptos', label: 'آپتوس', short: 'APT', native: 'APT', color: '#00B0FF',
    rpcs: ['https://fullnode.mainnet.aptoslabs.com'],
    addrHint: 'APT • 0x… (۶۴ کاراکتر)', wallets: 'Trust / Petra / Martian',
  },
  sui: {
    id: 'sui', label: 'سویی', short: 'SUI', native: 'SUI', color: '#4DA2FF',
    rpcs: ['https://sui-mainnet.mystenlabs.com/graphql'],
    addrHint: 'SUI • 0x… (۶۴ کاراکتر)', wallets: 'Trust / Sui Wallet / Slush',
  },
  stellar: {
    id: 'stellar', label: 'استلار', short: 'XLM', native: 'XLM', color: '#08B5E5',
    rpcs: ['https://horizon.stellar.org'],
    addrHint: 'XLM • G…', wallets: 'Trust / Freighter',
  },
  algorand: {
    id: 'algorand', label: 'الگورند', short: 'ALGO', native: 'ALGO', color: '#78909C',
    rpcs: ['https://mainnet-api.algonode.cloud'],
    addrHint: 'ALGO • ۵۸ کاراکتر',
  },
  tezos: {
    id: 'tezos', label: 'تزوس', short: 'XTZ', native: 'XTZ', color: '#2C7DF7',
    rpcs: ['https://api.tzkt.io'],
    addrHint: 'XTZ • tz1… / tz2… / tz3…', wallets: 'Trust / Temple',
  },
  multiversx: {
    id: 'multiversx', label: 'مالتی‌ورس‌ایکس', short: 'EGLD', native: 'EGLD', color: '#1FCAFF',
    rpcs: ['https://api.multiversx.com'],
    addrHint: 'EGLD • erd1…', wallets: 'Trust / xPortal',
  },
  hedera: {
    id: 'hedera', label: 'هدرا', short: 'HBAR', native: 'HBAR', color: '#A3C93A',
    rpcs: ['https://mainnet-public.mirrornode.hedera.com'],
    addrHint: 'HBAR • 0.0.12345', wallets: 'Trust / HashPack',
  },
  zilliqa: {
    id: 'zilliqa', label: 'زیلیکا', short: 'ZIL', native: 'ZIL', color: '#4C3B8D',
    rpcs: ['https://api.zilliqa.com'],
    addrHint: 'ZIL • zil1… / 0x…', wallets: 'Trust / Zillet / Moonlet',
  },
  vechain: {
    id: 'vechain', label: 'وی‌چین', short: 'VET', native: 'VET', color: '#37A5F5',
    rpcs: ['https://mainnet.veblocks.net'],
    addrHint: 'VET • 0x…', wallets: 'Trust / Sync / VeWorld',
  },
  kaspa: {
    id: 'kaspa', label: 'کسپا', short: 'KAS', native: 'KAS', color: '#38B2AC',
    rpcs: ['https://api.kaspa.org'],
    addrHint: 'KAS • kaspa:q… / kaspa:z…', wallets: 'Trust / Kaspa Wallet',
  },
};

export const EVM_NETWORKS: BlockchainNetwork[] = [
  'ethereum', 'bsc', 'polygon', 'arbitrum', 'base', 'optimism', 'avalanche',
  'fantom', 'zksync', 'linea', 'mantle', 'opbnb', 'scroll', 'blast', 'gnosis',
  'celo', 'cronos', 'moonbeam', 'moonriver', 'aurora', 'harmony', 'kcc',
  'fuse', 'xdc', 'zora', 'polygon-zkevm', 'immutable', 'sonic',
];

export const INDEPENDENT_NETWORKS: BlockchainNetwork[] = [
  'solana', 'ton', 'tron', 'filecoin', 'bitcoin', 'polkadot', 'xrp', 'cardano',
  'litecoin', 'dogecoin', 'bitcoin-cash', 'cosmos', 'near', 'aptos', 'sui',
  'stellar', 'algorand', 'tezos', 'multiversx', 'hedera', 'zilliqa', 'vechain',
  'kaspa',
];

/** Is the network an EVM chain (0x addresses, Multicall3, eth_call…)? */
export function isEvmNetwork(n: BlockchainNetwork): boolean {
  return EVM_NETWORKS.includes(n);
}

/** Networks of a wallet that share the EVM 0x address form. */
export function evmNetworksOf(list: BlockchainNetwork[]): BlockchainNetwork[] {
  return list.filter((n) => isEvmNetwork(n));
}

export interface NetworkGroup {
  id: 'evm' | 'independent';
  label: string;
  note: string;
  networks: BlockchainNetwork[];
}

export const NETWORK_GROUPS: NetworkGroup[] = [
  {
    id: 'evm',
    label: 'شبکه‌های اتریومی (EVM)',
    note: 'همه این شبکه‌ها یک آدرس مشترک 0x دارند — هر چند تای را که می‌خواهید تیک بزنید، همزمان خوانده می‌شوند.',
    networks: EVM_NETWORKS,
  },
  {
    id: 'independent',
    label: 'شبکه‌های مستقل',
    note: 'هر شبکه آدرس مخصوص خودش را دارد — مثل ترون با T، تون با UQ/EQ (کیف Tonkeeper) و سولانا با base58.',
    networks: INDEPENDENT_NETWORKS,
  },
];

// ---------------------------------------------------------------------------
// Curated TRC-20 tokens (contracts VERIFIED on-chain via symbol() calls)
// ---------------------------------------------------------------------------

export interface Trc20Token {
  symbol: string;
  name: string;
  /** base58 contract address on Tron. */
  contract: string;
  decimals: number;
  stable: boolean;
}

export const CURATED_TRC20: Trc20Token[] = [
  {
    symbol: 'USDT',
    name: 'تتر (TRC-20)',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    stable: true,
  },
  {
    symbol: 'USDC',
    name: 'یو‌اس‌دی‌کوین (TRC-20)',
    contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
    decimals: 6,
    stable: true,
  },
  // v1.4.18 — 4 more TRC-20 tokens, contracts re-verified ON-CHAIN
  // (symbol() + decimals() via TronGrid; addresses sourced from CoinGecko
  // platforms — ported from the GitHub v1.4.17 branch).
  {
    symbol: 'stUSDT',
    name: 'stUSDT (TRC-20)',
    contract: 'TThzxNRLrW2Brp9DcTQU8i4Wd9udCWEdZ3',
    decimals: 18,
    stable: true,
  },
  {
    symbol: 'JST',
    name: 'JUST (TRC-20)',
    contract: 'TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9',
    decimals: 18,
    stable: false,
  },
  {
    symbol: 'SUN',
    name: 'SUN (TRC-20)',
    contract: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
    decimals: 18,
    stable: false,
  },
  {
    symbol: 'WIN',
    name: 'WINkLink (TRC-20)',
    contract: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
    decimals: 6,
    stable: false,
  },
];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const WALLETS_KEY = '@blockchain_wallets_v1';
const BALANCE_CACHE_KEY = '@blockchain_balance_cache_v1';

/** v1.4.17 — parse + migrate (old single-network `network` field). */
function normalizeWallets(list: unknown): BlockchainWallet[] {
  if (!Array.isArray(list)) return [];
  const out: BlockchainWallet[] = [];
  for (const w of list) {
    if (!w || typeof w !== 'object') continue;
    const o = w as Partial<BlockchainWallet> & { network?: BlockchainNetwork };
    if (typeof o.id !== 'string' || typeof o.address !== 'string') continue;
    const nets: BlockchainNetwork[] = Array.isArray(o.networks)
      ? o.networks.filter((n) => n in NETWORKS)
      : o.network && o.network in NETWORKS
        ? [o.network]
        : [];
    if (nets.length === 0) continue;
    out.push({
      id: o.id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name : 'کیف پول',
      networks: nets,
      address: o.address,
      addedAt: typeof o.addedAt === 'number' ? o.addedAt : Date.now(),
    });
  }
  return out;
}

export async function loadBlockchainWallets(): Promise<BlockchainWallet[]> {
  try {
    const raw = await AsyncStorage.getItem(WALLETS_KEY);
    if (raw) {
      const list = normalizeWallets(JSON.parse(raw));
      // persist the migrated shape right away (v1.4.16 → v1.4.17)
      const needsResave =
        JSON.stringify(list) !== raw;
      if (needsResave && list.length > 0) {
        await AsyncStorage.setItem(WALLETS_KEY, JSON.stringify(list));
      }
      return list;
    }
  } catch {}
  return [];
}

export async function saveBlockchainWallets(wallets: BlockchainWallet[]): Promise<void> {
  try {
    await AsyncStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
  } catch {}
}

export async function readBlockchainBalanceCache(
  id: string
): Promise<BlockchainWalletData | null> {
  try {
    const raw = await AsyncStorage.getItem(BALANCE_CACHE_KEY);
    if (raw) {
      const map = JSON.parse(raw) as Record<string, BlockchainWalletData>;
      return map[id] ?? null;
    }
  } catch {}
  return null;
}

export async function writeBlockchainBalanceCache(data: BlockchainWalletData): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(BALANCE_CACHE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, BlockchainWalletData>) : {};
    map[data.walletId] = data;
    await AsyncStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(map));
  } catch {}
}

export async function removeBlockchainBalanceCache(id: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(BALANCE_CACHE_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, BlockchainWalletData>;
    delete map[id];
    await AsyncStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(map));
  } catch {}
}

// ---------------------------------------------------------------------------
// Address validation (per network)
// ---------------------------------------------------------------------------

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BECH32_BODY = '[02-9ac-hj-np-z]';

/**
 * Base58check decode with double-SHA256 checksum verify (Tron).
 * Returns the 21-byte hex form (0x41 + 20 bytes) that TronGrid accepts,
 * or null when the address fails format/checksum.
 */
function tronAddressToHex(addr: string): string | null {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return null;
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  try {
    const zeros = addr.length - addr.replace(/^1+/, '').length;
    let n = 0n;
    for (const c of addr) {
      const idx = ALPHABET.indexOf(c);
      if (idx < 0) return null;
      n = n * 58n + BigInt(idx);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    hex = '00'.repeat(zeros) + hex;
    if (hex.length !== 50) return null; // 25 bytes: 0x41 + 20 + 4 checksum
    const payload = hex.slice(0, 42);
    if (!payload.startsWith('41')) return null;
    const words: number[] = new Array(6).fill(0);
    for (let i = 0; i < 21; i++) {
      const b = parseInt(payload.slice(i * 2, i * 2 + 2), 16);
      words[i >> 2] |= b << (24 - 8 * (i & 3));
    }
    const wa = CryptoJS.lib.WordArray.create(words, 21);
    const hash = CryptoJS.SHA256(CryptoJS.SHA256(wa)).toString();
    if (hash.slice(0, 8) !== hex.slice(42)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Generic bech32 decode (BIP-173) → data bytes; used for zilliqa. */
export function bech32Decode(addr: string): { hrp: string; data: Uint8Array } | null {
  const pos = addr.lastIndexOf('1');
  if (pos < 1 || pos + 7 > addr.length) return null;
  const hrp = addr.slice(0, pos);
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data: number[] = [];
  for (const ch of addr.slice(pos + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  // convert 5-bit groups to bytes
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return { hrp, data: new Uint8Array(out) };
}

/** ss58 decode → 32-byte accountId (Polkadot); null when malformed. */
export function ss58Decode(address: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{45,50}$/.test(address)) return null;
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  try {
    const zeros = address.length - address.replace(/^1+/, '').length;
    let n = 0n;
    for (const c of address) {
      const idx = ALPHABET.indexOf(c);
      if (idx < 0) return null;
      n = n * 58n + BigInt(idx);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    hex = '00'.repeat(zeros) + hex;
    // version(1) + accountId(32) + checksum(2 or 4) → 70 or 74 hex chars
    if (hex.length !== 70 && hex.length !== 74) return null;
    const payload = new Uint8Array(
      (hex.slice(2, 66).match(/../g) ?? []).map((h) => parseInt(h, 16))
    );
    return payload.length === 32 ? payload : null; // 32-byte AccountId32
  } catch {
    return null;
  }
}

/** ss58 verify checksum via blake2b-8 (best-effort; invalid → still returns bytes). */
export function ss58ChecksumOk(address: string, accountId: Uint8Array): boolean {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  try {
    const prefixBytes = [0]; // Polkadot mainnet ss58 format = 0
    const payload = new Uint8Array([...prefixBytes, ...accountId]);
    const cs = blake2b(payload, 8);
    // find the last 4 bytes of the base58 decoded value
    let n = 0n;
    for (const c of address) {
      const idx = ALPHABET.indexOf(c);
      if (idx < 0) return false;
      n = n * 58n + BigInt(idx);
    }
    const zeros = address.length - address.replace(/^1+/, '').length;
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    hex = '00'.repeat(zeros) + hex;
    if (hex.length !== 70 && hex.length !== 74) return false;
    const csLen = hex.length === 70 ? 2 : 4;
    const expected = hex.slice(-csLen * 2);
    // checksum covers [version(=0), accountId] — best effort (2 or 4 bytes)
    const full = blake2b8Hex(new Uint8Array([0, ...accountId]));
    return full.startsWith(expected) || full.slice(0, csLen * 2) === expected;
  } catch {
    return false;
  }
}

/** Polkadot System.Account storage key for an accountId (blake2-256). */
export function polkadotStorageKey(accountId: Uint8Array): string {
  const prefix = '26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9';
  return '0x' + prefix + blake2b256Hex(accountId);
}

export function validateBlockchainAddress(
  network: BlockchainNetwork,
  address: string
): { ok: boolean; message?: string } {
  const a = address.trim();
  if (!a) return { ok: false, message: 'آدرس را وارد کنید' };

  if (isEvmNetwork(network) || network === 'vechain') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
      return { ok: false, message: 'آدرس EVM معتبر نیست — باید با 0x شروع شود و ۴۲ کاراکتر باشد' };
    }
    return { ok: true };
  }

  switch (network) {
    case 'filecoin': {
      if (/^f[134][0-9a-zA-Z]{8,60}$/.test(a) || /^f0\d+$/.test(a) || /^0x[0-9a-fA-F]{40}$/.test(a)) {
        return { ok: true };
      }
      return { ok: false, message: 'آدرس فایل‌کوین معتبر نیست — با f1… (تراست) یا 0x… شروع می‌شود' };
    }
    case 'tron': {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) {
        return { ok: false, message: 'آدرس ترون معتبر نیست — با T شروع می‌شود و ۳۴ کاراکتر دارد' };
      }
      if (tronAddressToHex(a) === null) {
        return { ok: false, message: 'چک‌سام آدرس ترون نامعتبر است — آدرس را دوباره کپی کنید' };
      }
      return { ok: true };
    }
    case 'bitcoin': {
      if (/^(bc1)[02-9ac-hj-np-z]{11,71}$/i.test(a) || /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) {
        return { ok: true };
      }
      return { ok: false, message: 'آدرس بیت‌کوین معتبر نیست — باید با bc1 یا 1 یا 3 شروع شود' };
    }
    case 'litecoin': {
      if (/^(ltc1)[02-9ac-hj-np-z]{11,71}$/i.test(a) || /^[LM][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) {
        return { ok: true };
      }
      return { ok: false, message: 'آدرس لایت‌کوین معتبر نیست — باید با ltc1 یا L یا M شروع شود' };
    }
    case 'dogecoin': {
      if (/^D[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس دوج‌کوین معتبر نیست — با D شروع می‌شود' };
    }
    case 'bitcoin-cash': {
      if (
        /^(bitcoincash:)?(q|p)[02-9ac-hj-np-z]{41}$/i.test(a) ||
        /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)
      ) {
        return { ok: true };
      }
      return { ok: false, message: 'آدرس BCH معتبر نیست — باید bitcoincash:q… یا q… یا 1… باشد' };
    }
    case 'solana': {
      if (a.length >= 32 && a.length <= 44 && BASE58_RE.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس سولانا معتبر نیست (۳۲ تا ۴۴ کاراکتر base58)' };
    }
    case 'ton': {
      if (/^(EQ|UQ)[-_A-Za-z0-9+/]{46,47}$/.test(a)) return { ok: true };
      if (/^-?1:[0-9a-fA-F]{64}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس تون معتبر نیست — کیف Tonkeeper آدرس UQ/EQ می‌دهد' };
    }
    case 'xrp': {
      if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس ریپل معتبر نیست — با r شروع می‌شود' };
    }
    case 'cardano': {
      if (/^addr1[02-9ac-hj-np-z]{50,70}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس کاردانو معتبر نیست — با addr1 شروع می‌شود' };
    }
    case 'polkadot': {
      if (ss58Decode(a) === null) {
        return { ok: false, message: 'آدرس پولکادات معتبر نیست — ۴۷ کاراکتر و معمولاً با 1 شروع می‌شود' };
      }
      return { ok: true };
    }
    case 'cosmos': {
      if (/^cosmos1[02-9ac-hj-np-z]{38,45}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس کازموس معتبر نیست — با cosmos1 شروع می‌شود' };
    }
    case 'near': {
      if (/^[a-z0-9_-]{2,64}(\.[a-z0-9_-]{2,64})*$/.test(a) && !/^0x/.test(a)) return { ok: true };
      if (/^0x[0-9a-fA-F]{64}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس نیر معتبر نیست — نام حساب (مثلاً wallet.near) یا hex ۶۴تایی' };
    }
    case 'aptos': {
      if (/^0x[0-9a-fA-F]{32,64}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس آپتوس معتبر نیست — 0x + ۶۴ کاراکتر hex' };
    }
    case 'sui': {
      if (/^0x[0-9a-fA-F]{64}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس سویی معتبر نیست — 0x + ۶۴ کاراکتر hex' };
    }
    case 'stellar': {
      if (/^G[A-Z2-7]{55}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس استلار معتبر نیست — با G شروع می‌شود (۵۶ کاراکتر)' };
    }
    case 'algorand': {
      if (/^[A-Z2-7]{58}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس الگورند معتبر نیست (۵۸ کاراکتر)' };
    }
    case 'tezos': {
      if (/^tz[1-3][1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس تزوس معتبر نیست — با tz1/tz2/tz3 شروع می‌شود' };
    }
    case 'multiversx': {
      if (/^erd1[02-9ac-hj-np-z]{58,60}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس مالتی‌ورس‌ایکس معتبر نیست — با erd1 شروع می‌شود' };
    }
    case 'hedera': {
      if (/^\d+\.\d+\.\d+$/.test(a)) return { ok: true };
      if (/^0x[0-9a-fA-F]{40}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس هدرا معتبر نیست — به شکل 0.0.12345' };
    }
    case 'zilliqa': {
      if (/^zil1[02-9ac-hj-np-z]{38,40}$/.test(a)) return { ok: true };
      if (/^0x[0-9a-fA-F]{40}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس زیلیکا معتبر نیست — با zil1 یا 0x شروع می‌شود' };
    }
    case 'kaspa': {
      if (/^kaspa:[02-9ac-hj-np-z]{40,62}$/.test(a)) return { ok: true };
      return { ok: false, message: 'آدرس کسپا معتبر نیست — به شکل kaspa:q…' };
    }
  }
  // unreachable (every network is handled above) — satisfies the checker
  return { ok: false, message: 'شبکه پشتیبانی نمی‌شود' };
}

/**
 * Validate one address against ALL selected networks — returns the first
 * failure (or ok). Used by the add/edit form.
 */
export function validateAddressForNetworks(
  networks: BlockchainNetwork[],
  address: string,
  networkAddresses?: Partial<Record<BlockchainNetwork, string>>
): { ok: boolean; network?: BlockchainNetwork; message?: string } {
  for (const n of networks) {
    // v1.4.19 — a per-network override replaces the base address for THAT
    // network only (e.g. base 0x for Ethereum+BSC + f1 for Filecoin).
    const perNet = networkAddresses?.[n]?.trim();
    if (perNet) {
      const vPer = validateBlockchainAddress(n, perNet);
      if (!vPer.ok) return { ok: false, network: n, message: `${NETWORKS[n].label} (آدرس اختصاصی): ${vPer.message}` };
      continue;
    }
    const v = validateBlockchainAddress(n, address);
    if (!v.ok) {
      // v1.4.19 — if the BASE address doesn't fit this network, the fix is
      // entering that network's own address (the form shows the input).
      return {
        ok: false,
        network: n,
        message: `${NETWORKS[n].label}: آدرس این شبکه را در کادر اختصاصی همان شبکه وارد کنید (${v.message})`,
      };
    }
  }
  return { ok: true };
}

/**
 * v1.4.19 — the address actually used to read a network. Per-network
 * override wins; otherwise the wallet's base address (EVM 0x shared).
 */
export function addressForNetwork(
  wallet: Pick<BlockchainWallet, 'address' | 'networkAddresses'>,
  network: BlockchainNetwork
): string {
  const per = wallet.networkAddresses?.[network]?.trim();
  return per && per.length > 0 ? per : wallet.address.trim();
}

/** Tron hex form (21 bytes, no checksum) for TronGrid calls — null if invalid. */
export function tronHexAddress(addr: string): string | null {
  return tronAddressToHex(addr);
}

/** zilliqa bech32 (zil1…) → base16 20-byte address; 0x forms pass through. */
export function zilliqaBase16(addr: string): string | null {
  const a = addr.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a;
  const dec = bech32Decode(a.toLowerCase());
  if (!dec || dec.data.length !== 20) return null;
  return (
    '0x' + [...dec.data].map((b) => b.toString(16).padStart(2, '0')).join('')
  );
}

/** Shortened address for display: 0x71C7…9A3f */
export function shortAddress(address: string): string {
  const a = address.trim();
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
