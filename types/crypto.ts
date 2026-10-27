export type ExchangeId =
  | 'binance'
  | 'bybit'
  | 'okx'
  | 'kucoin'
  | 'toobit'
  | 'bingx'
  | 'mexc'
  | 'bitunix'
  | 'bitget'
  | 'gateio'
  | 'htx'
  | 'coinex'
  | 'xt'
  | 'lbank'
  | 'phemex'
  | 'superex'
  | 'bitmart'
  | 'kcex'
  | 'orbiter'
  | 'huobi'
  | 'nobitex'
  | 'arzinja'
  | 'iranicart'
  | 'bitperp';

export type SignalType = 'pump' | 'dump';

export interface ExchangeInfo {
  id: ExchangeId;
  name: string;
  makerFee: number;
  takerFee: number;
  futuresBaseUrl: string;
}

export interface FuturesTicker {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  count: number;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  displayName: string;
  signalType: SignalType;
  currentPrice: number;
  priceChangePercent: number;
  volume24h: number;
  volumeChangeRatio: number;
  buyVolumeRatio: number;
  sellVolumeRatio: number;
  suggestedEntry: number;
  suggestedTarget: number;
  suggestedStopLoss: number;
  strength: 'high' | 'medium' | 'low';
  detectedAt: Date;
  reason: string;
  fundingRate: number;
  timeframe: string;
}

export interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: string;
  takerBuyQuoteAssetVolume: string;
}

export interface CustomIndicator {
  id: string;
  name: string;
  code: string;
  timeframe: string;
  enabled: boolean;
  createdAt: number;
}

export interface AppSettings {
  apiKey: string;
  apiSecret: string;
  scanInterval: number;
  volumeThreshold: number;
  notificationsEnabled: boolean;
  scannerNotifications: boolean;
  whaleNotifications: boolean;
  exchange: ExchangeId;
  marginAmount: number;
  leverage: number;
  riskRewardRatio: number;
  indicators: CustomIndicator[];
  selectedIndicatorIds: string[];
  customCoins: string[];
  useCustomCoinsOnly: boolean;
  refreshInterval: number;
  scanFilterMode: 'all' | 'top_gainers' | 'top_losers' | 'new_listings';
  useVolumeOnlySignals: boolean;
  memeShortNotifications: boolean;
  preListingNotifications: boolean;
  tradeAiNotifications: boolean;
  gainzAlgoNotifications: boolean;
  /** Which timeframes the server-side GainzAlgo scan covers. */
  gainzTimeframes: ('15m' | '30m' | '1h' | '4h' | '1d')[];
  /** Arzinja (Iranian exchange) API keys — live USDT/Toman price source. */
  arzinjaApiKey: string;
  arzinjaApiSecret: string;
  hookReversalNotifications: boolean;
  /** Which timeframes the server-side Hook Reversal scan covers. */
  hookTimeframes: ('4h' | '1d')[];
  telegramBotToken: string;
  telegramChatId: string;
  telegramEnabled: boolean;
  /** UI theme — 'dark' (default) or 'light'. */
  themeMode?: 'dark' | 'light';
  /** Home-scanner auto mode — persisted so it survives app restarts. */
  autoScanEnabled?: boolean;
}

/** All GainzAlgo-supported scan timeframes. */
export type GainzTimeframe = '15m' | '30m' | '1h' | '4h' | '1d';
