/**
 * Pocket Option OTC Telegram Signal Bridge
 *
 * Signal-only bot.
 * Expiry: 5 minutes.
 *
 * Required environment variables:
 * TELEGRAM_BOT_TOKEN
 * TELEGRAM_CHAT_ID
 *
 * POST candle data to /candles
 *
 * Expected JSON:
 * {
 *   "symbol": "EURUSD_otc",
 *   "candles": [
 *     {
 *       "open": 1.1000,
 *       "high": 1.1010,
 *       "low": 1.0990,
 *       "close": 1.1005
 *     }
 *   ]
 * }
 */

const http = require("http");

const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MIN_SCORE = 72;
const MIN_ADVANTAGE = 18;

const EXPIRY_MINUTES = 5;

// Avoid sending repeated signals for the same pair too frequently.
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;

const lastSignals = new Map();

const ALLOWED_PAIRS = new Set([
  "EURUSD_otc",
  "GBPUSD_otc",
  "USDJPY_otc",
  "USDCHF_otc",
  "AUDUSD_otc",
  "USDCAD_otc",
  "NZDUSD_otc",
  "EURGBP_otc",
  "EURJPY_otc",
  "GBPJPY_otc",
  "AUDJPY_otc",
  "EURCHF_otc",
  "GBPCHF_otc",
  "CADJPY_otc",
  "CHFJPY_otc"
]);

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;

  const relativeStrength = averageGain / averageLoss;

  return 100 - 100 / (1 + relativeStrength);
}

function analyzeCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 50) {
    throw new Error("At least 50 candles are required");
  }

  for (const candle of candles) {
    if (
      !Number.isFinite(Number(candle.open)) ||
      !Number.isFinite(Number(candle.high)) ||
      !Number.isFinite(Number(candle.low)) ||
      !Number.isFinite(Number(candle.close))
    ) {
      throw new Error("Invalid candle data");
    }
  }

  const closes = candles.map(c => Number(c.close));

  const current = closes[closes.length - 1];
  const previous = closes[closes.length - 2];

  const fastEMA = ema(closes, 9);
  const slowEMA = ema(closes, 21);
  const trendEMA = ema(closes, 50);

  const rsi = calculateRSI(closes, 14);

  if (
    fastEMA === null ||
    slowEMA === null ||
    trendEMA === null ||
    rsi === null
  ) {
    throw new Error("Indicators could not be calculated");
  }

  let buyScore = 0;
  let sellScore = 0;

  const reasons = [];

  // Trend direction.
  if (fastEMA > slowEMA && current > trendEMA) {
    buyScore += 30;
    reasons.push("Bullish EMA trend");
  }

  if (fastEMA < slowEMA && current < trendEMA) {
    sellScore += 30;
    reasons.push("Bearish EMA trend");
  }

  // Short-term momentum.
  if (current > previous) {
    buyScore += 15;
  }

  if (current < previous) {
    sellScore += 15;
  }

  // RSI confirmation.
  if (rsi >= 50 && rsi <= 68) {
    buyScore += 25;
    reasons.push("Bullish RSI confirmation");
  }

  if (rsi <= 50 && rsi >= 32) {
    sellScore += 25;
    reasons.push("Bearish RSI confirmation");
  }

  // Candle strength.
  const lastCandle = candles[candles.length - 1];

  const open = Number(lastCandle.open);
  const high = Number(lastCandle.high);
  const low = Number(lastCandle.low);
  const close = Number(lastCandle.close);

  const range = high - low;

  if (range > 0) {
    const bodyStrength = Math.abs(close - open) / range;

    if (close > open && bodyStrength >= 0.55) {
      buyScore += 20;
      reasons.push("Strong bullish candle");
    }

    if (close < open && bodyStrength >= 0.55) {
      sellScore += 20;
      reasons.push("Strong bearish candle");
    }
  }

  const advantage = Math.abs(buyScore - sellScore);

  let signal = "WAIT";
  let score = Math.max(buyScore, sellScore);

  if (
    buyScore >= MIN_SCORE &&
    buyScore - sellScore >= MIN_ADVANTAGE
  ) {
    signal = "BUY";
    score = buyScore;
  } else if (
    sellScore >= MIN_SCORE &&
    sellScore - buyScore >= MIN_ADVANTAGE
  ) {
    signal = "SELL";
    score = sellScore;
  }

  return {
    signal,
    score,
    buyScore,
    sellScore,
    advantage,
    rsi: Number(rsi.toFixed(2)),
    entry: current,
    analysis:
      reasons.length > 0
        ? reasons.join("; ")
        : "No sufficiently confirmed trend or momentum setup"
  };
}

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing"
    );
  }

  const url =
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "HTML"
    })
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || "Telegram message failed"
    );
  }

  return result;
}

function formatSignal(symbol, result) {
  return [
    "🟢 <b>POCKET OPTION OTC SIGNAL</b>",
    "",
    `💱 Pair: <b>${symbol}</b>`,
    `📊 Signal: <b>${result.signal}</b>`,
    `⏱ Expiry: <b>${EXPIRY_MINUTES} minutes</b>`,
    `💰 Entry: <b>${result.entry}</b>`,
    `📈 Signal score: <b>${result.score}/100</b>`,
    `📉 BUY score: ${result.buyScore}`,
    `📉 SELL score: ${result.sellScore}`,
    `📊 RSI: ${result.rsi}`,
    "",
    `📝 Analysis: ${result.analysis}`,
    "",
    "⚠️ Signal is based on received candle data.",
    "⚠️ No trade has been placed automatically."
  ].join("\n");
}

async function handleCandles(payload) {
  const symbol = String(payload.symbol || "").trim();

  if (!ALLOWED_PAIRS.has(symbol)) {
    throw new Error("Unsupported OTC pair");
  }

  const result = analyzeCandles(payload.candles);

  // WAIT is internal. Do not send WAIT alerts.
  if (result.signal === "WAIT") {
    return {
      ok: true,
      signal: "WAIT",
      sent: false,
      analysis: result.analysis,
      buyScore: result.buyScore,
      sellScore: result.sellScore
    };
  }

  const now = Date.now();
  const previousSignal = lastSignals.get(symbol);

  if (
    previousSignal &&
    previousSignal.signal === result.signal &&
    now - previousSignal.time < SIGNAL_COOLDOWN_MS
  ) {
    return {
      ok: true,
      signal: result.signal,
      sent: false,
      reason: "Duplicate signal cooldown"
    };
  }

  await sendTelegram(formatSignal(symbol, result));

  lastSignals.set(symbol, {
    signal: result.signal,
    time: now
  });

  return {
    ok: true,
    signal: result.signal,
    sent: true,
    score: result.score,
    buyScore: result.buyScore,
    sellScore: result.sellScore,
    entry: result.entry,
    expiryMinutes: EXPIRY_MINUTES,
    analysis: result.analysis
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });

    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    return jsonResponse(res, 200, {
      ok: true,
      service: "Pocket Option OTC Telegram Bridge",
      expiryMinutes: EXPIRY_MINUTES,
      telegramConfigured: Boolean(BOT_TOKEN && CHAT_ID)
    });
  }

  if (req.method === "POST" && req.url === "/candles") {
    try {
      const payload = await readBody(req);
      const result = await handleCandles(payload);

      return jsonResponse(res, 200, result);
    } catch (error) {
      console.error("Request error:", error.message);

      return jsonResponse(res, 400, {
        ok: false,
        error: error.message
      });
    }
  }

  return jsonResponse(res, 404, {
    ok: false,
    error: "Route not found"
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Pocket Option OTC bridge listening on port ${PORT}`
  );
});
