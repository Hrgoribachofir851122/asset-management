import { FuturesTicker, TradeSignal, ExchangeId } from '@/types/crypto';
import { EXCHANGES } from '@/constants/exchanges';

const FUTURES_BASE = 'https://fapi.binance.com';

export async function fetchFuturesTickers(): Promise<FuturesTicker[]> {
  console.log('[BinanceAPI] Fetching futures tickers...');
  const response = await fetch(`${FUTURES_BASE}/fapi/v1/ticker/24hr`);
  if (!response.ok) {
    throw new Error(`خطا در دریافت اطلاعات: ${response.status}`);
  }
  const data: FuturesTicker[] = await response.json();
  const usdtPairs = data.filter((t) => t.symbol.endsWith('USDT'));
  console.log(`[BinanceAPI] Got ${usdtPairs.length} USDT futures pairs`);
  return usdtPairs;
}

export async function fetchKlines(
  symbol: string,
  interval: string = '1h',
  limit: number = 24
): Promise<number[][]> {
  console.log(`[BinanceAPI] Fetching klines for ${symbol}...`);
  const response = await fetch(
    `${FUTURES_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  if (!response.ok) {
    throw new Error(`خطا در دریافت کندل‌ها: ${response.status}`);
  }
  return response.json();
}

export async function fetchTakerVolume(symbol: string): Promise<{ buyVol: number; sellVol: number }> {
  try {
    const klines = await fetchKlines(symbol, '5m', 12);
    let buyVol = 0;
    let totalVol = 0;

    for (const k of klines) {
      totalVol += parseFloat(String(k[5]));
      buyVol += parseFloat(String(k[9]));
    }

    return { buyVol, sellVol: totalVol - buyVol };
  } catch {
    return { buyVol: 0, sellVol: 0 };
  }
}

export async function fetchFundingRate(symbol: string): Promise<number> {
  try {
    console.log(`[BinanceAPI] Fetching funding rate for ${symbol}...`);
    const response = await fetch(
      `${FUTURES_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`
    );
    if (!response.ok) {
      console.log(`[BinanceAPI] premiumIndex failed for ${symbol}, status: ${response.status}`);
      return 0;
    }
    const data = await response.json();
    if (data && data.lastFundingRate) {
      const rate = parseFloat(data.lastFundingRate);
      console.log(`[BinanceAPI] Funding rate for ${symbol}: ${rate}`);
      return rate;
    }
    return 0;
  } catch (e) {
    console.log(`[BinanceAPI] Error fetching funding rate for ${symbol}:`, e);
    return 0;
  }
}

export function getExchangeFees(exchangeId: ExchangeId) {
  const exchange = EXCHANGES[exchangeId];
  return {
    makerFee: exchange.makerFee,
    takerFee: exchange.takerFee,
  };
}

function formatSymbolName(symbol: string): string {
  return symbol.replace('USDT', '') + '/USDT';
}

export async function scanForPumpSignals(
  volumeThreshold: number = 2.0
): Promise<TradeSignal[]> {
  console.log('[Scanner] Starting pump signal scan...');
  const tickers = await fetchFuturesTickers();

  const filtered = tickers.filter((t) => {
    const quoteVol = parseFloat(t.quoteVolume);
    const priceChange = parseFloat(t.priceChangePercent);
    return quoteVol > 5000000 && priceChange > -5 && priceChange < 15;
  });

  console.log(`[Scanner] ${filtered.length} pairs passed initial pump filter`);

  const topByVolume = filtered
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 30);

  const signals: TradeSignal[] = [];

  for (const ticker of topByVolume) {
    try {
      const klines = await fetchKlines(ticker.symbol, '1h', 24);
      if (klines.length < 12) continue;

      const recentVolumes = klines.slice(-4).map((k) => parseFloat(String(k[5])));
      const olderVolumes = klines.slice(-12, -4).map((k) => parseFloat(String(k[5])));

      const avgRecent = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const avgOlder = olderVolumes.reduce((a, b) => a + b, 0) / olderVolumes.length;
      const volumeRatio = avgOlder > 0 ? avgRecent / avgOlder : 0;

      if (volumeRatio < volumeThreshold) continue;

      const { buyVol, sellVol } = await fetchTakerVolume(ticker.symbol);
      const totalVol = buyVol + sellVol;
      const buyRatio = totalVol > 0 ? buyVol / totalVol : 0.5;
      const sellRatio = totalVol > 0 ? sellVol / totalVol : 0.5;

      if (buyRatio < 0.55) continue;

      const fundingRate = await fetchFundingRate(ticker.symbol);

      const currentPrice = parseFloat(ticker.lastPrice);
      const priceChange = parseFloat(ticker.priceChangePercent);

      let strength: 'high' | 'medium' | 'low' = 'low';
      if (volumeRatio > 3.5 && buyRatio > 0.65) strength = 'high';
      else if (volumeRatio > 2.5 && buyRatio > 0.6) strength = 'medium';

      let reason = '';
      if (volumeRatio > 3) {
        reason = `حجم معاملات ${volumeRatio.toFixed(1)} برابر میانگین شده`;
      } else {
        reason = `افزایش ${volumeRatio.toFixed(1)} برابری حجم`;
      }
      if (buyRatio > 0.65) {
        reason += ` • خریداران ${(buyRatio * 100).toFixed(0)}% بازار`;
      } else {
        reason += ` • نسبت خرید ${(buyRatio * 100).toFixed(0)}%`;
      }

      const suggestedEntry = currentPrice;
      const suggestedTarget = currentPrice * (1 + (strength === 'high' ? 0.05 : strength === 'medium' ? 0.03 : 0.02));
      const suggestedStopLoss = currentPrice * 0.985;

      signals.push({
        id: `pump-${ticker.symbol}-${Date.now()}`,
        symbol: ticker.symbol,
        displayName: formatSymbolName(ticker.symbol),
        signalType: 'pump',
        currentPrice,
        priceChangePercent: priceChange,
        volume24h: parseFloat(ticker.quoteVolume),
        volumeChangeRatio: volumeRatio,
        buyVolumeRatio: buyRatio,
        sellVolumeRatio: sellRatio,
        suggestedEntry,
        suggestedTarget,
        suggestedStopLoss,
        strength,
        detectedAt: new Date(),
        reason,
        fundingRate,
        timeframe: '1h',
      });
    } catch (err) {
      console.log(`[Scanner] Error analyzing ${ticker.symbol} for pump:`, err);
    }
  }

  signals.sort((a, b) => {
    const strengthOrder = { high: 0, medium: 1, low: 2 };
    return strengthOrder[a.strength] - strengthOrder[b.strength];
  });

  console.log(`[Scanner] Found ${signals.length} pump signals`);
  return signals;
}

export async function scanForDumpSignals(
  volumeThreshold: number = 2.0
): Promise<TradeSignal[]> {
  console.log('[Scanner] Starting dump signal scan...');
  const tickers = await fetchFuturesTickers();

  const filtered = tickers.filter((t) => {
    const quoteVol = parseFloat(t.quoteVolume);
    const priceChange = parseFloat(t.priceChangePercent);
    return quoteVol > 5000000 && priceChange < 5 && priceChange > -15;
  });

  console.log(`[Scanner] ${filtered.length} pairs passed initial dump filter`);

  const topByVolume = filtered
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 30);

  const signals: TradeSignal[] = [];

  for (const ticker of topByVolume) {
    try {
      const klines = await fetchKlines(ticker.symbol, '1h', 24);
      if (klines.length < 12) continue;

      const recentVolumes = klines.slice(-4).map((k) => parseFloat(String(k[5])));
      const olderVolumes = klines.slice(-12, -4).map((k) => parseFloat(String(k[5])));

      const avgRecent = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const avgOlder = olderVolumes.reduce((a, b) => a + b, 0) / olderVolumes.length;
      const volumeRatio = avgOlder > 0 ? avgRecent / avgOlder : 0;

      if (volumeRatio < volumeThreshold) continue;

      const { buyVol, sellVol } = await fetchTakerVolume(ticker.symbol);
      const totalVol = buyVol + sellVol;
      const sellRatio = totalVol > 0 ? sellVol / totalVol : 0.5;
      const buyRatio = totalVol > 0 ? buyVol / totalVol : 0.5;

      if (sellRatio < 0.55) continue;

      const fundingRate = await fetchFundingRate(ticker.symbol);

      const currentPrice = parseFloat(ticker.lastPrice);
      const priceChange = parseFloat(ticker.priceChangePercent);

      let strength: 'high' | 'medium' | 'low' = 'low';
      if (volumeRatio > 3.5 && sellRatio > 0.65) strength = 'high';
      else if (volumeRatio > 2.5 && sellRatio > 0.6) strength = 'medium';

      let reason = '';
      if (volumeRatio > 3) {
        reason = `حجم فروش ${volumeRatio.toFixed(1)} برابر میانگین شده`;
      } else {
        reason = `افزایش ${volumeRatio.toFixed(1)} برابری حجم فروش`;
      }
      if (sellRatio > 0.65) {
        reason += ` • فروشندگان ${(sellRatio * 100).toFixed(0)}% بازار`;
      } else {
        reason += ` • نسبت فروش ${(sellRatio * 100).toFixed(0)}%`;
      }

      const suggestedEntry = currentPrice;
      const suggestedTarget = currentPrice * (1 - (strength === 'high' ? 0.05 : strength === 'medium' ? 0.03 : 0.02));
      const suggestedStopLoss = currentPrice * 1.015;

      signals.push({
        id: `dump-${ticker.symbol}-${Date.now()}`,
        symbol: ticker.symbol,
        displayName: formatSymbolName(ticker.symbol),
        signalType: 'dump',
        currentPrice,
        priceChangePercent: priceChange,
        volume24h: parseFloat(ticker.quoteVolume),
        volumeChangeRatio: volumeRatio,
        buyVolumeRatio: buyRatio,
        sellVolumeRatio: sellRatio,
        suggestedEntry,
        suggestedTarget,
        suggestedStopLoss,
        strength,
        detectedAt: new Date(),
        reason,
        fundingRate,
        timeframe: '1h',
      });
    } catch (err) {
      console.log(`[Scanner] Error analyzing ${ticker.symbol} for dump:`, err);
    }
  }

  signals.sort((a, b) => {
    const strengthOrder = { high: 0, medium: 1, low: 2 };
    return strengthOrder[a.strength] - strengthOrder[b.strength];
  });

  console.log(`[Scanner] Found ${signals.length} dump signals`);
  return signals;
}

export async function scanAllSignals(
  volumeThreshold: number = 2.0
): Promise<TradeSignal[]> {
  console.log('[Scanner] Starting full scan (pump + dump)...');
  const [pumpSignals, dumpSignals] = await Promise.all([
    scanForPumpSignals(volumeThreshold),
    scanForDumpSignals(volumeThreshold),
  ]);

  const allSignals = [...pumpSignals, ...dumpSignals];
  allSignals.sort((a, b) => {
    const strengthOrder = { high: 0, medium: 1, low: 2 };
    return strengthOrder[a.strength] - strengthOrder[b.strength];
  });

  console.log(`[Scanner] Total signals: ${allSignals.length} (${pumpSignals.length} pump, ${dumpSignals.length} dump)`);
  return allSignals;
}
