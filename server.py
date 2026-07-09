"""
LiteChart — web backend.

Serves OHLCV data (Alpaca, with automatic Yahoo Finance fallback — see
DATA_PROVIDER in .env) plus server-computed indicators as JSON, and hosts a
single-page frontend that renders everything with TradingView Lightweight
Charts (loaded from a CDN).

Run:
    conda run -n py3 python server.py
then open http://127.0.0.1:5000
"""

import atexit
import math
import os
import signal
import socket
import ssl
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone

def _probe_ssl_ok(url: str = "https://query1.finance.yahoo.com", timeout: float = 5) -> bool:
    """Try a real HTTPS request with certificate verification ON.

    Uses `requests` (certifi's CA bundle) rather than the stdlib `ssl`
    module, because on Windows `ssl.create_default_context()` trusts the OS
    certificate store — which corporate IT may have seeded with its
    TLS-inspection root — while `requests`/`curl_cffi`/alpaca-py all verify
    against certifi's bundle instead and would still fail. Probing with the
    same mechanism the app actually uses avoids that false negative.

    Returns True (stay secure) unless the request fails specifically because
    of a broken/untrusted cert chain. Any other failure (offline, DNS,
    timeout) also returns True, since that's not evidence verification
    itself is the problem.
    """
    import requests as _bootstrap_requests
    try:
        _bootstrap_requests.get(url, timeout=timeout)
        return True
    except _bootstrap_requests.exceptions.SSLError:
        return False
    except Exception:
        return True


# Verify TLS certs normally first; only relax verification process-wide if a
# real probe proves this machine's network can't validate the chain.
_SSL_VERIFY = _probe_ssl_ok()

if not _SSL_VERIFY:
    print("[litechart] TLS certificate verification failed for outbound HTTPS "
          "(likely a corporate proxy/SSL-inspection root Python doesn't trust). "
          "Falling back to unverified HTTPS for outbound market-data requests only.")
    os.environ["PYTHONHTTPSVERIFY"] = "0"
    os.environ["CURL_CA_BUNDLE"] = ""
    os.environ["REQUESTS_CA_BUNDLE"] = ""
    ssl._create_default_https_context = ssl._create_unverified_context
    try:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    except Exception:
        pass
    # `requests.Session` (used internally by libs like alpaca-py that don't
    # expose a verify= knob) still checks certs against certifi by default —
    # patch it too so those calls don't fail with the same error.
    try:
        import requests as _rq_bootstrap
        _orig_session_request = _rq_bootstrap.Session.request

        def _unverified_session_request(self, *args, **kwargs):
            kwargs.setdefault("verify", False)
            return _orig_session_request(self, *args, **kwargs)

        _rq_bootstrap.Session.request = _unverified_session_request
    except Exception:
        pass

# Impersonate Chrome so Yahoo Finance doesn't block/rate-limit us.
try:
    from curl_cffi.requests import Session as CurlSession
    _YF_SESSION = CurlSession(impersonate="chrome120", verify=_SSL_VERIFY, timeout=20)
except Exception:
    _YF_SESSION = None

import numpy as np
import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, render_template, request

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass

# ─────────────────────────── Data provider ─────────────────────────────
# "alpaca" (with automatic Yahoo fallback for anything Alpaca can't serve —
# indices, FX, obscure/foreign tickers) or "yahoo" (Yahoo only). Configured
# via .env, which is git-ignored — see .env.example.
DATA_PROVIDER = (os.environ.get("DATA_PROVIDER") or "yahoo").strip().lower()
ALPACA_API_KEY = os.environ.get("ALPACA_API_KEY") or ""
ALPACA_SECRET_KEY = os.environ.get("ALPACA_SECRET_KEY") or ""
ALPACA_FEED = (os.environ.get("ALPACA_FEED") or "iex").strip().lower()
ALPACA_FALLBACK_YAHOO = (os.environ.get("ALPACA_FALLBACK_YAHOO") or "1").strip() not in ("0", "false", "no")

_ALPACA_CLIENT = None
_AlpacaAPIError = Exception
if DATA_PROVIDER == "alpaca":
    if not (ALPACA_API_KEY and ALPACA_SECRET_KEY):
        print("[litechart] DATA_PROVIDER=alpaca but ALPACA_API_KEY/ALPACA_SECRET_KEY "
              "are missing in .env — using Yahoo Finance only.")
    else:
        try:
            from alpaca.data.historical import StockHistoricalDataClient
            from alpaca.common.exceptions import APIError as _AlpacaAPIError
            _ALPACA_CLIENT = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)
            print(f"[litechart] Data provider: Alpaca (feed={ALPACA_FEED}), "
                  f"Yahoo fallback: {'on' if ALPACA_FALLBACK_YAHOO else 'off'}")
        except Exception as e:  # noqa: BLE001
            print(f"[litechart] Alpaca init failed ({e}) — using Yahoo Finance only.")
            _ALPACA_CLIENT = None


# ─────────────────────────── Indicators ───────────────────────────────
def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def bollinger(series: pd.Series, period=20, std=2):
    mid = sma(series, period)
    sigma = series.rolling(period).std()
    return mid - std * sigma, mid, mid + std * sigma


def rsi(series: pd.Series, period=14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def vwap(df: pd.DataFrame) -> pd.Series:
    """Rolling VWAP reset each calendar day (session-based, TradingView style)."""
    tp = (df["High"] + df["Low"] + df["Close"]) / 3.0
    tpv = tp * df["Volume"]
    day = df.index.normalize()
    cum_tpv = tpv.groupby(day).cumsum()
    cum_vol = df["Volume"].groupby(day).cumsum().replace(0, np.nan)
    return cum_tpv / cum_vol


def stochastic(df: pd.DataFrame, k=14, d=3):
    low_k = df["Low"].rolling(k).min()
    high_k = df["High"].rolling(k).max()
    denom = (high_k - low_k).replace(0, np.nan)
    k_line = 100 * (df["Close"] - low_k) / denom
    d_line = k_line.rolling(d).mean()
    return k_line, d_line


def kdj(df: pd.DataFrame, length=9, k_smooth=3, d_smooth=3):
    """KDJ oscillator. RSV is the raw stochastic; K and D are Wilder-style
    (SMMA/EMA) smoothings of it, and J = 3K - 2D over-extends past K/D.

    K = SMMA(RSV, k_smooth), D = SMMA(K, d_smooth), J = 3K - 2D.
    """
    low_n = df["Low"].rolling(length).min()
    high_n = df["High"].rolling(length).max()
    denom = (high_n - low_n).replace(0, np.nan)
    rsv = 100 * (df["Close"] - low_n) / denom
    rsv = rsv.fillna(50)
    # SMMA with alpha = 1/period (equivalent to the classic 2/3·prev + 1/3·now
    # when smoothing = 3), seeded so early values are stable.
    k_line = rsv.ewm(alpha=1.0 / k_smooth, adjust=False).mean()
    d_line = k_line.ewm(alpha=1.0 / d_smooth, adjust=False).mean()
    j_line = 3 * k_line - 2 * d_line
    return k_line, d_line, j_line


def _true_range(df: pd.DataFrame) -> pd.Series:
    hi, lo, cl = df["High"], df["Low"], df["Close"]
    prev = cl.shift(1)
    return pd.concat([hi - lo, (hi - prev).abs(), (lo - prev).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, period=14) -> pd.Series:
    return _true_range(df).rolling(period).mean()


# ── Extra moving averages ──
def wma(series: pd.Series, period: int) -> pd.Series:
    weights = np.arange(1, period + 1)
    return series.rolling(period).apply(lambda w: np.dot(w, weights) / weights.sum(), raw=True)


def hma(series: pd.Series, period: int) -> pd.Series:
    half = max(1, period // 2)
    sqrt_n = max(1, int(round(np.sqrt(period))))
    return wma(2 * wma(series, half) - wma(series, period), sqrt_n)


def smma(series: pd.Series, period: int) -> pd.Series:
    """Smoothed / running moving average (Wilder's RMA)."""
    return series.ewm(alpha=1.0 / period, adjust=False).mean()


def vwma(df: pd.DataFrame, period: int) -> pd.Series:
    pv = (df["Close"] * df["Volume"]).rolling(period).sum()
    vol = df["Volume"].rolling(period).sum().replace(0, np.nan)
    return pv / vol


def _vwma_series(series: pd.Series, volume: pd.Series, period: int) -> pd.Series:
    pv = (series * volume).rolling(period).sum()
    vol = volume.rolling(period).sum().replace(0, np.nan)
    return pv / vol


# ── Reusable smoothing block (TradingView-style RSI/oscillator smoothing) ──
SMOOTH_TYPES = ["None", "SMA", "SMA + Bollinger Bands", "EMA", "SMMA (RMA)", "WMA", "VWMA"]


def smooth_ma(series: pd.Series, ma_type: str, length: int, volume: pd.Series = None) -> pd.Series:
    t = (ma_type or "SMA").upper()
    length = max(1, int(length))
    if t.startswith("SMA"):
        return sma(series, length)
    if t.startswith("EMA"):
        return ema(series, length)
    if t.startswith("SMMA") or t == "RMA":
        return smma(series, length)
    if t.startswith("WMA"):
        return wma(series, length)
    if t.startswith("VWMA"):
        if volume is None:
            return sma(series, length)
        return _vwma_series(series, volume, length)
    return sma(series, length)


def apply_smoothing(series: pd.Series, ma_type: str, length: int, bb_std: float = 2.0,
                    volume: pd.Series = None) -> dict:
    """Return {'ma','bb_upper','bb_lower'} smoothing overlays for an oscillator.

    Mirrors TradingView: 'None' → no smoothing; 'SMA + Bollinger Bands' → SMA
    plus ±stddev bands; every other type → just that MA line.
    """
    norm = " ".join((ma_type or "").split()).lower()  # collapse stray whitespace
    if not norm or norm == "none":
        return {}
    ma = smooth_ma(series, ma_type, length, volume)
    out = {"ma": ma}
    if "bollinger" in norm:
        sigma = series.rolling(int(length)).std()
        out["bb_upper"] = ma + float(bb_std) * sigma
        out["bb_lower"] = ma - float(bb_std) * sigma
    return out


def dema(series: pd.Series, period: int) -> pd.Series:
    e1 = ema(series, period)
    return 2 * e1 - ema(e1, period)


def tema(series: pd.Series, period: int) -> pd.Series:
    e1 = ema(series, period)
    e2 = ema(e1, period)
    e3 = ema(e2, period)
    return 3 * e1 - 3 * e2 + e3


# ── Channels / bands ──
def keltner(df: pd.DataFrame, period=20, mult=2.0):
    mid = ema(df["Close"], period)
    rng = mult * atr(df, period)
    return mid - rng, mid, mid + rng


def donchian(df: pd.DataFrame, period=20):
    hi = df["High"].rolling(period).max()
    lo = df["Low"].rolling(period).min()
    return lo, (hi + lo) / 2, hi


# ── Trend ──
def supertrend(df: pd.DataFrame, period=10, mult=3.0) -> pd.Series:
    hl2 = (df["High"] + df["Low"]) / 2
    a = atr(df, period)
    upper = hl2 + mult * a
    lower = hl2 - mult * a
    close = df["Close"].to_numpy(float)
    up = upper.to_numpy(float)
    lo = lower.to_numpy(float)
    st = np.full(len(df), np.nan)
    dir_up = True
    for i in range(len(df)):
        if i == 0 or np.isnan(up[i]) or np.isnan(lo[i]):
            st[i] = up[i] if not np.isnan(up[i]) else np.nan
            continue
        if not np.isnan(st[i - 1]):
            if dir_up:
                lo[i] = max(lo[i], lo[i - 1]) if not np.isnan(lo[i - 1]) else lo[i]
            else:
                up[i] = min(up[i], up[i - 1]) if not np.isnan(up[i - 1]) else up[i]
        if dir_up and close[i] < lo[i]:
            dir_up = False
        elif (not dir_up) and close[i] > up[i]:
            dir_up = True
        st[i] = lo[i] if dir_up else up[i]
    return pd.Series(st, index=df.index)


def parabolic_sar(df: pd.DataFrame, af_step=0.02, af_max=0.2) -> pd.Series:
    high = df["High"].to_numpy(float)
    low = df["Low"].to_numpy(float)
    n = len(df)
    psar = np.full(n, np.nan)
    if n < 2:
        return pd.Series(psar, index=df.index)
    bull = True
    af = af_step
    ep = high[0]
    psar[0] = low[0]
    for i in range(1, n):
        psar[i] = psar[i - 1] + af * (ep - psar[i - 1])
        if bull:
            if low[i] < psar[i]:
                bull = False
                psar[i] = ep
                ep = low[i]
                af = af_step
            else:
                if high[i] > ep:
                    ep = high[i]
                    af = min(af + af_step, af_max)
        else:
            if high[i] > psar[i]:
                bull = True
                psar[i] = ep
                ep = high[i]
                af = af_step
            else:
                if low[i] < ep:
                    ep = low[i]
                    af = min(af + af_step, af_max)
    return pd.Series(psar, index=df.index)


def adx_dmi(df: pd.DataFrame, period=14):
    up = df["High"].diff()
    dn = -df["Low"].diff()
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    tr = _true_range(df)
    atr_ = tr.ewm(alpha=1 / period, adjust=False).mean().replace(0, np.nan)
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(alpha=1 / period, adjust=False).mean() / atr_
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(alpha=1 / period, adjust=False).mean() / atr_
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(alpha=1 / period, adjust=False).mean()
    return plus_di, minus_di, adx


# ── Oscillators / momentum ──
def cci(df: pd.DataFrame, period=20) -> pd.Series:
    tp = (df["High"] + df["Low"] + df["Close"]) / 3
    ma = tp.rolling(period).mean()
    md = (tp - ma).abs().rolling(period).mean().replace(0, np.nan)
    return (tp - ma) / (0.015 * md)


def williams_r(df: pd.DataFrame, period=14) -> pd.Series:
    hh = df["High"].rolling(period).max()
    ll = df["Low"].rolling(period).min()
    denom = (hh - ll).replace(0, np.nan)
    return -100 * (hh - df["Close"]) / denom


def roc(series: pd.Series, period=12) -> pd.Series:
    return 100 * (series - series.shift(period)) / series.shift(period)


def momentum(series: pd.Series, period=10) -> pd.Series:
    return series - series.shift(period)


def stoch_rsi(series: pd.Series, rsi_len=14, stoch_len=14, k=3, d=3):
    r = rsi(series, rsi_len)
    lo = r.rolling(stoch_len).min()
    hi = r.rolling(stoch_len).max()
    denom = (hi - lo).replace(0, np.nan)
    k_line = (100 * (r - lo) / denom).rolling(k).mean()
    d_line = k_line.rolling(d).mean()
    return k_line, d_line


def tsi(series: pd.Series, long=25, short=13):
    m = series.diff()
    ds = m.ewm(span=long, adjust=False).mean().ewm(span=short, adjust=False).mean()
    da = m.abs().ewm(span=long, adjust=False).mean().ewm(span=short, adjust=False).mean().replace(0, np.nan)
    return 100 * ds / da


def awesome_osc(df: pd.DataFrame) -> pd.Series:
    hl2 = (df["High"] + df["Low"]) / 2
    return hl2.rolling(5).mean() - hl2.rolling(34).mean()


# ── Volume ──
def obv(df: pd.DataFrame) -> pd.Series:
    sign = np.sign(df["Close"].diff().fillna(0))
    return (sign * df["Volume"]).fillna(0).cumsum()


def mfi(df: pd.DataFrame, period=14) -> pd.Series:
    tp = (df["High"] + df["Low"] + df["Close"]) / 3
    rmf = tp * df["Volume"]
    pos = rmf.where(tp > tp.shift(1), 0.0).rolling(period).sum()
    neg = rmf.where(tp < tp.shift(1), 0.0).rolling(period).sum().replace(0, np.nan)
    return 100 - 100 / (1 + pos / neg)


def cmf(df: pd.DataFrame, period=20) -> pd.Series:
    rng = (df["High"] - df["Low"]).replace(0, np.nan)
    mfv = ((2 * df["Close"] - df["Low"] - df["High"]) / rng) * df["Volume"]
    return mfv.rolling(period).sum() / df["Volume"].rolling(period).sum().replace(0, np.nan)


def macd(series: pd.Series, fast=12, slow=26, signal=9):
    e_fast = ema(series, fast)
    e_slow = ema(series, slow)
    line = e_fast - e_slow
    sig = ema(line, signal)
    hist = line - sig
    return line, sig, hist


# ─────────────────────────── Data fetch ───────────────────────────────
PERIOD_MAP = {
    "1m":  ("7d",   "1m"),
    "2m":  ("7d",   "2m"),
    "3m":  ("7d",   "1m"),    # aggregated from 1m
    "5m":  ("60d",  "5m"),
    "10m": ("60d",  "5m"),    # aggregated from 5m
    "15m": ("60d",  "15m"),
    "30m": ("60d",  "30m"),
    "45m": ("60d",  "15m"),   # aggregated from 15m
    "1h":  ("730d", "1h"),    # Yahoo caps 60m at ~730 days
    "2h":  ("730d", "1h"),    # aggregated from 1h
    "3h":  ("730d", "1h"),    # aggregated from 1h
    "4h":  ("730d", "1h"),    # aggregated from 1h
    "1D":  ("15y",  "1d"),    # ~15 years of daily history
    "1W":  ("max",  "1wk"),   # full available weekly history
    "1M":  ("max",  "1mo"),   # full available monthly history
}

# Timeframes that must be resampled from a finer native interval.
_RESAMPLE = {
    "3m":  "3min",
    "10m": "10min",
    "45m": "45min",
    "2h":  "2h",
    "3h":  "3h",
    "4h":  "4h",
}

# Alpaca timeframe mapping: (native bar size to request, how far back to
# start). Mirrors PERIOD_MAP's native/resample split above so both providers
# feed the exact same _RESAMPLE step and produce identical bar boundaries.
if _ALPACA_CLIENT is not None:
    from alpaca.data.timeframe import TimeFrame, TimeFrameUnit

    _ALPACA_TF_MAP = {
        "1m":  (TimeFrame(1, TimeFrameUnit.Minute),  timedelta(days=7)),
        "2m":  (TimeFrame(2, TimeFrameUnit.Minute),  timedelta(days=7)),
        "3m":  (TimeFrame(1, TimeFrameUnit.Minute),  timedelta(days=7)),
        "5m":  (TimeFrame(5, TimeFrameUnit.Minute),  timedelta(days=60)),
        "10m": (TimeFrame(5, TimeFrameUnit.Minute),  timedelta(days=60)),
        "15m": (TimeFrame(15, TimeFrameUnit.Minute), timedelta(days=60)),
        "30m": (TimeFrame(30, TimeFrameUnit.Minute), timedelta(days=60)),
        "45m": (TimeFrame(15, TimeFrameUnit.Minute), timedelta(days=60)),
        "1h":  (TimeFrame(1, TimeFrameUnit.Hour),    timedelta(days=730)),
        "2h":  (TimeFrame(1, TimeFrameUnit.Hour),    timedelta(days=730)),
        "3h":  (TimeFrame(1, TimeFrameUnit.Hour),    timedelta(days=730)),
        "4h":  (TimeFrame(1, TimeFrameUnit.Hour),    timedelta(days=730)),
        "1D":  (TimeFrame(1, TimeFrameUnit.Day),     timedelta(days=365 * 20)),
        "1W":  (TimeFrame(1, TimeFrameUnit.Week),    timedelta(days=365 * 20)),
        "1M":  (TimeFrame(1, TimeFrameUnit.Month),   timedelta(days=365 * 20)),
    }

# TradingView palette (used for volume / MACD histogram point colors)
C_GREEN = "#26a69a"
C_RED = "#ef5350"


# Short-lived cache so the many per-indicator requests for one symbol/timeframe
# don't each hit Yahoo. Keyed by (symbol, timeframe); expires after TTL seconds.
_DF_CACHE = {}
_DF_TTL = 60.0


def fetch_df(symbol: str, timeframe: str) -> pd.DataFrame:
    key = (symbol.upper(), timeframe)
    cached = _DF_CACHE.get(key)
    if cached is not None and (time.time() - cached[0]) < _DF_TTL:
        return cached[1]
    df = _fetch_df_uncached(symbol, timeframe)
    _DF_CACHE[key] = (time.time(), df)
    return df


# Yahoo's raw "info" blob (name, sector, valuation, analyst ratings, …) is
# expensive-ish and rarely changes, so it's fetched once and shared by both
# fetch_name() and fetch_overview() via this cache.
_INFO_CACHE: dict = {}          # symbol -> (fetched_at, info dict)
_INFO_TTL = 3600                # 1 hour — analyst data updates infrequently


def _fetch_yf_info(symbol: str) -> dict:
    sym = symbol.upper()
    cached = _INFO_CACHE.get(sym)
    if cached is not None and (time.time() - cached[0]) < _INFO_TTL:
        return cached[1]
    info = {}
    try:
        tk = yf.Ticker(sym, session=_YF_SESSION)
        try:
            info = tk.get_info() or {}
        except Exception:  # noqa: BLE001
            info = getattr(tk, "info", {}) or {}
    except Exception:  # noqa: BLE001
        info = {}
    _INFO_CACHE[sym] = (time.time(), info)
    return info


def fetch_name(symbol: str) -> str:
    """Best-effort human-readable company name for a ticker (cached).

    Falls back to the bare symbol if Yahoo has no name / the lookup fails, so
    a slow or failed metadata call never blocks the price payload.
    """
    sym = symbol.upper()
    info = _fetch_yf_info(sym)
    name = (info.get("longName") or info.get("shortName")
            or info.get("displayName") or "").strip()
    return name or sym


def fetch_overview(symbol: str) -> dict:
    """Curated fundamentals + analyst-opinion snapshot for the Overview panel.

    Best-effort: any missing field is simply omitted (None) rather than
    failing the whole request — coverage varies a lot by ticker (large caps
    are rich, small caps/ETFs/indices are often sparse).
    """
    sym = symbol.upper()
    info = _fetch_yf_info(sym)

    def g(*keys):
        for k in keys:
            v = info.get(k)
            if v is not None:
                return v
        return None

    out = {
        "symbol": sym,
        "name": g("longName", "shortName", "displayName") or sym,
        "sector": g("sector"),
        "industry": g("industry"),
        "exchange": g("fullExchangeName", "exchange"),
        "currency": g("currency"),
        "marketCap": g("marketCap"),
        "trailingPE": g("trailingPE"),
        "forwardPE": g("forwardPE"),
        "beta": g("beta"),
        "dividendYield": g("dividendYield"),
        "payoutRatio": g("payoutRatio"),
        "fiftyTwoWeekLow": g("fiftyTwoWeekLow"),
        "fiftyTwoWeekHigh": g("fiftyTwoWeekHigh"),
        "profitMargins": g("profitMargins"),
        "returnOnEquity": g("returnOnEquity"),
        "revenueGrowth": g("revenueGrowth"),
        "earningsGrowth": g("earningsGrowth"),
        "totalCash": g("totalCash"),
        "totalDebt": g("totalDebt"),
        "recommendationKey": g("recommendationKey"),
        "recommendationMean": g("recommendationMean"),
        "numberOfAnalystOpinions": g("numberOfAnalystOpinions"),
        "targetLowPrice": g("targetLowPrice"),
        "targetMeanPrice": g("targetMeanPrice"),
        "targetMedianPrice": g("targetMedianPrice"),
        "targetHighPrice": g("targetHighPrice"),
        "currentPrice": g("currentPrice", "regularMarketPrice"),
        "longBusinessSummary": g("longBusinessSummary"),
    }
    # True if Yahoo gave us essentially nothing useful (e.g. delisted/obscure
    # symbol) so the UI can show a clear "no data" state instead of all dashes.
    out["hasData"] = any(v is not None for k, v in out.items()
                         if k not in ("symbol", "name", "hasData"))
    return out


def _resample_ohlcv(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    rule = _RESAMPLE.get(timeframe)
    if not rule:
        return df
    return df.resample(rule).agg({
        "Open": "first", "High": "max",
        "Low": "min", "Close": "last",
        "Volume": "sum",
    }).dropna()


def _fetch_yahoo_df(symbol: str, timeframe: str, period_override: str = None) -> pd.DataFrame:
    period, interval = PERIOD_MAP.get(timeframe, ("1y", "1d"))
    if period_override:
        period = period_override
    last_err = ""
    for attempt in range(3):
        if attempt > 0:
            time.sleep(3 * attempt)
        try:
            tk = yf.Ticker(symbol, session=_YF_SESSION)
            df = tk.history(period=period, interval=interval,
                            auto_adjust=True, timeout=20)
            if df is None or df.empty:
                last_err = f"No data for '{symbol}' — check the symbol."
                continue
            df.index = pd.to_datetime(df.index, utc=True).tz_convert(None)
            df = _resample_ohlcv(df, timeframe)
            df = df[~df.index.duplicated(keep="last")].sort_index()
            return df
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            if "Rate" in last_err or "429" in last_err:
                continue
            break
    raise RuntimeError(last_err or "Unknown fetch error")


def _fetch_alpaca_df(symbol: str, timeframe: str, lookback_override: timedelta = None) -> pd.DataFrame:
    """Raises on any failure (bad/unsupported symbol, auth, rate limit, no
    data) so the caller can decide whether to fall back to Yahoo.
    """
    from alpaca.data.requests import StockBarsRequest

    tf_obj, lookback = _ALPACA_TF_MAP.get(timeframe, _ALPACA_TF_MAP["1D"])
    if lookback_override is not None:
        lookback = lookback_override
    req = StockBarsRequest(
        symbol_or_symbols=symbol,
        timeframe=tf_obj,
        start=datetime.now(timezone.utc) - lookback,
        feed=ALPACA_FEED,
    )
    bars = _ALPACA_CLIENT.get_stock_bars(req)
    df = bars.df
    if df is None or df.empty:
        raise RuntimeError(f"Alpaca returned no data for '{symbol}'.")
    # get_stock_bars(...).df is MultiIndex (symbol, timestamp) even for a
    # single symbol — drop the symbol level to get a plain time series.
    if isinstance(df.index, pd.MultiIndex):
        df = df.xs(symbol, level=0)
    df = df.rename(columns={
        "open": "Open", "high": "High", "low": "Low",
        "close": "Close", "volume": "Volume",
    })[["Open", "High", "Low", "Close", "Volume"]]
    df.index = pd.to_datetime(df.index, utc=True).tz_convert(None)
    df = _resample_ohlcv(df, timeframe)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


def _fetch_df_uncached(symbol: str, timeframe: str) -> pd.DataFrame:
    if _ALPACA_CLIENT is not None:
        try:
            return _fetch_alpaca_df(symbol, timeframe)
        except Exception as e:  # noqa: BLE001
            if not ALPACA_FALLBACK_YAHOO:
                raise
            print(f"[litechart] Alpaca fetch failed for '{symbol}' ({timeframe}): {e} "
                  f"— falling back to Yahoo Finance.")
    return _fetch_yahoo_df(symbol, timeframe)


def _fetch_df_bounded(symbol: str, timeframe: str, days: int) -> pd.DataFrame:
    """Like _fetch_df_uncached(), but caps the lookback to ~`days` calendar
    days instead of the full chart-length history. Used only by the
    screener's reduced-history path (see fetch_screener_df below).
    """
    if _ALPACA_CLIENT is not None:
        try:
            return _fetch_alpaca_df(symbol, timeframe, lookback_override=timedelta(days=days))
        except Exception as e:  # noqa: BLE001
            if not ALPACA_FALLBACK_YAHOO:
                raise
            print(f"[litechart] Alpaca fetch failed for '{symbol}' ({timeframe}): {e} "
                  f"— falling back to Yahoo Finance.")
    # Yahoo's period param wants coarse buckets ("1y", "2y", …) rather than
    # arbitrary day counts, so round up to the nearest year.
    years = max(1, math.ceil(days / 365))
    return _fetch_yahoo_df(symbol, timeframe, period_override=f"{years}y")


# ─────────────────────── Screener reduced-lookback fetch ────────────────
# Screener rule functions only ever read the last 1-2 rows of each computed
# indicator (e.g. rsi.iloc[-1]), so a scan never needs the full chart-length
# history (15y of daily bars, "max" weekly/monthly, …) — just enough
# trailing bars for the longest indicator lookback among the *selected*
# rules, plus a buffer so EWM-style indicators (MACD, ADX, Supertrend) have
# settled by the last bar. This only applies to 1D/1W/1M, where the normal
# chart lookback is wildly larger than any rule needs; intraday timeframes
# already use provider-bounded windows (7d/60d/730d) that aren't worth
# further trimming. Local pandas compute cost is negligible either way —
# this is purely about cutting the upstream Alpaca/Yahoo fetch on a cold
# cache, not about CPU.
_SCREENER_DF_CACHE: dict = {}          # (symbol, timeframe) -> (fetched_at, days_used, df)
_SCREENER_MAX_DAYS = {"1D": 15 * 365, "1W": 20 * 365, "1M": 20 * 365}


def _rule_min_bars(rule_id: str, params: dict) -> int:
    """Trailing bars needed for `rule_id` to produce a stable, non-NaN
    signal on the most recent bar. EWM-based indicators (MACD/ADX/
    Supertrend) get an extra multiplier since they need several periods to
    converge, not just their nominal window length."""
    p = params
    if rule_id == "rsi":
        return int(p["length"]) * 4 + 10
    if rule_id == "macd_cross":
        return int(p["slow"]) * 3 + int(p["signal"]) * 3 + 10
    if rule_id == "ma_cross":
        return int(p["slow"]) + 10
    if rule_id == "bb_touch":
        return int(p["length"]) + 10
    if rule_id == "stoch":
        return int(p["k_length"]) + int(p["d_length"]) + 10
    if rule_id == "williams_r":
        return int(p["length"]) + 10
    if rule_id == "cci":
        return int(p["length"]) + 10
    if rule_id == "mfi":
        return int(p["length"]) + 10
    if rule_id == "adx_cross":
        return int(p["length"]) * 4 + 20
    if rule_id == "supertrend_flip":
        return int(p["length"]) * 4 + 20
    return 250   # unknown rule — safe fallback


def _screener_lookback_days(timeframe: str, min_bars: int) -> int:
    """Calendar days comfortably covering `min_bars` trailing bars of
    `timeframe`, capped at the timeframe's normal full-history ceiling."""
    if timeframe == "1D":
        needed = int(min_bars * (7 / 5) * 1.35) + 30    # trading→calendar days + holiday buffer
    elif timeframe == "1W":
        needed = int(min_bars * 7 * 1.35) + 60
    elif timeframe == "1M":
        needed = int(min_bars * 30 * 1.35) + 90
    else:
        needed = _SCREENER_MAX_DAYS.get(timeframe, 10 ** 9)
    return min(needed, _SCREENER_MAX_DAYS.get(timeframe, needed))


def fetch_screener_df(symbol: str, timeframe: str, min_bars: int) -> pd.DataFrame:
    """Like fetch_df(), but for 1D/1W/1M only fetches enough trailing bars
    for the rules being scanned. Other timeframes delegate straight to the
    normal fetch_df() (see module docstring above for why).
    """
    if timeframe not in _SCREENER_MAX_DAYS:
        return fetch_df(symbol, timeframe)

    sym = symbol.upper()
    # A fresh full chart-length fetch (from the chart/indicator endpoints)
    # already covers any min_bars — reuse it instead of fetching again.
    full_cached = _DF_CACHE.get((sym, timeframe))
    if full_cached is not None and (time.time() - full_cached[0]) < _DF_TTL:
        return full_cached[1]

    days = _screener_lookback_days(timeframe, min_bars)
    key = (sym, timeframe)
    cached = _SCREENER_DF_CACHE.get(key)
    if cached is not None:
        fetched_at, days_used, df = cached
        if (time.time() - fetched_at) < _DF_TTL and days_used >= days:
            return df

    df = _fetch_df_bounded(sym, timeframe, days)
    _SCREENER_DF_CACHE[key] = (time.time(), days, df)
    return df


# ─────────────────────────── Serialization ────────────────────────────
def _epoch(index: pd.DatetimeIndex) -> np.ndarray:
    """UTC seconds — the time format Lightweight Charts understands."""
    return (index.view(np.int64) // 10**9).astype(np.int64)


def line_points(index, values):
    """[{time, value}] skipping NaN so the chart draws clean lines."""
    ts = _epoch(index)
    out = []
    for t, v in zip(ts, values):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            continue
        out.append({"time": int(t), "value": round(float(v), 4)})
    return out


def hist_points(index, values, up_ref):
    """Histogram points (volume / macd) colored green/red by up_ref sign."""
    ts = _epoch(index)
    out = []
    for t, v, up in zip(ts, values, up_ref):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            continue
        out.append({
            "time": int(t),
            "value": round(float(v), 4),
            "color": C_GREEN if up else C_RED,
        })
    return out


def build_data(symbol: str, timeframe: str) -> dict:
    """OHLCV payload only. Indicators are computed separately per-instance."""
    df = fetch_df(symbol, timeframe)
    ts = _epoch(df.index)
    o = df["Open"].to_numpy(float)
    h = df["High"].to_numpy(float)
    l = df["Low"].to_numpy(float)
    c = df["Close"].to_numpy(float)
    v = df["Volume"].to_numpy(float)
    up_mask = c >= o
    candles = [
        {"time": int(ts[i]),
         "open": round(o[i], 4), "high": round(h[i], 4),
         "low": round(l[i], 4), "close": round(c[i], 4)}
        for i in range(len(df))
    ]
    return {
        "symbol": symbol.upper(),
        "name": fetch_name(symbol),
        "timeframe": timeframe,
        "candles": candles,
        "volume": hist_points(df.index, v, up_mask),
    }


# ─────────────────────── Indicator registry ───────────────────────────
# Each indicator declares:
#   overlay : draw on the price pane (True) or its own pane (False)
#   inputs  : ordered list of {key, label, type, default, options?}
#   plots   : list of plot keys returned (order matters for the frontend)
#   compute : (df, params) -> { plotKey: pandas.Series }  (or hist dict)

def _src(df: pd.DataFrame, name: str) -> pd.Series:
    name = (name or "close").lower()
    cols = {"open": "Open", "high": "High", "low": "Low", "close": "Close"}
    if name in cols:
        return df[cols[name]]
    if name == "hl2":
        return (df["High"] + df["Low"]) / 2
    if name == "hlc3":
        return (df["High"] + df["Low"] + df["Close"]) / 3
    if name == "ohlc4":
        return (df["Open"] + df["High"] + df["Low"] + df["Close"]) / 4
    return df["Close"]


SRC_OPTS = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"]
LEN = lambda d=14: {"key": "length", "label": "Length", "type": "int", "default": d}
SRCIN = {"key": "source", "label": "Source", "type": "select", "default": "close", "options": SRC_OPTS}
OFFS = {"key": "offset", "label": "Offset", "type": "int", "default": 0}


def _ma_inputs(d):
    return [LEN(d), SRCIN, OFFS]


# Reusable smoothing inputs (TradingView-style). `group` renders a section
# header in the settings dialog; `enabledWhen` disables a field until another
# field has a matching value.
SMOOTH_INPUTS = [
    {"key": "smoothType", "label": "Type", "type": "select", "default": "None",
     "options": SMOOTH_TYPES, "group": "Smoothing"},
    {"key": "smoothLen", "label": "Length", "type": "int", "default": 14, "group": "Smoothing",
     "enabledWhen": {"key": "smoothType", "notEquals": "None"}},
    {"key": "smoothBBStd", "label": "BB StdDev", "type": "float", "default": 2.0, "group": "Smoothing",
     "enabledWhen": {"key": "smoothType", "equals": "SMA + Bollinger Bands"}},
]


def _compute_rsi(df, p):
    base = rsi(_src(df, p["source"]), int(p["length"]))
    out = {"plot0": base}
    sm = apply_smoothing(base, p.get("smoothType", "None"), int(p.get("smoothLen", 14) or 14),
                         float(p.get("smoothBBStd", 2.0) or 2.0), volume=df["Volume"])
    if "ma" in sm:
        out["ma"] = sm["ma"]
    if "bb_upper" in sm:
        out["bb_upper"] = sm["bb_upper"]
        out["bb_lower"] = sm["bb_lower"]
    return out


INDICATORS = {
    # ── Overlays: moving averages ──
    "sma":  {"name": "SMA", "overlay": True, "inputs": _ma_inputs(20), "plots": ["plot0"],
             "compute": lambda df, p: {"plot0": sma(_src(df, p["source"]), int(p["length"]))}},
    "ema":  {"name": "EMA", "overlay": True, "inputs": _ma_inputs(20), "plots": ["plot0"],
             "compute": lambda df, p: {"plot0": ema(_src(df, p["source"]), int(p["length"]))}},
    "wma":  {"name": "WMA", "overlay": True, "inputs": _ma_inputs(20), "plots": ["plot0"],
             "compute": lambda df, p: {"plot0": wma(_src(df, p["source"]), int(p["length"]))}},
    "hma":  {"name": "Hull MA", "overlay": True, "inputs": _ma_inputs(20), "plots": ["plot0"],
             "compute": lambda df, p: {"plot0": hma(_src(df, p["source"]), int(p["length"]))}},
    "vwma": {"name": "VWMA", "overlay": True, "inputs": [LEN(20), OFFS], "plots": ["plot0"],
             "compute": lambda df, p: {"plot0": vwma(df, int(p["length"]))}},
    "dema": {"name": "DEMA", "overlay": True, "inputs": _ma_inputs(20), "plots": ["plot0"],
             "compute": lambda df, p: {"plot0": dema(_src(df, p["source"]), int(p["length"]))}},
    "tema": {"name": "TEMA", "overlay": True, "inputs": _ma_inputs(20), "plots": ["plot0"],
             "compute": lambda df, p: {"plot0": tema(_src(df, p["source"]), int(p["length"]))}},
    "vwap": {"name": "VWAP", "overlay": True, "inputs": [], "plots": ["plot0"],
             "compute": lambda df, p: {"plot0": vwap(df)}},
    # ── Overlays: bands (3 plots) ──
    "bb": {"name": "Bollinger Bands", "overlay": True,
           "inputs": [LEN(20), SRCIN, {"key": "mult", "label": "StdDev", "type": "float", "default": 2.0}],
           "plots": ["plot0", "plot1", "plot2"],
           "compute": lambda df, p: (lambda lo, mid, hi: {"plot0": hi, "plot1": mid, "plot2": lo})(
               *bollinger(_src(df, p["source"]), int(p["length"]), float(p["mult"])))},
    "keltner": {"name": "Keltner Channels", "overlay": True,
                "inputs": [LEN(20), {"key": "mult", "label": "Multiplier", "type": "float", "default": 2.0}],
                "plots": ["plot0", "plot1", "plot2"],
                "compute": lambda df, p: (lambda lo, mid, hi: {"plot0": hi, "plot1": mid, "plot2": lo})(
                    *keltner(df, int(p["length"]), float(p["mult"])))},
    "donchian": {"name": "Donchian Channels", "overlay": True, "inputs": [LEN(20)],
                 "plots": ["plot0", "plot1", "plot2"],
                 "compute": lambda df, p: (lambda lo, mid, hi: {"plot0": hi, "plot1": mid, "plot2": lo})(
                     *donchian(df, int(p["length"])))},
    # ── Overlays: trend ──
    "supertrend": {"name": "Supertrend", "overlay": True,
                   "inputs": [{"key": "length", "label": "ATR Length", "type": "int", "default": 10},
                              {"key": "mult", "label": "Factor", "type": "float", "default": 3.0}],
                   "plots": ["plot0"],
                   "compute": lambda df, p: {"plot0": supertrend(df, int(p["length"]), float(p["mult"]))}},
    "psar": {"name": "Parabolic SAR", "overlay": True,
             "inputs": [{"key": "step", "label": "Start", "type": "float", "default": 0.02},
                        {"key": "max", "label": "Max", "type": "float", "default": 0.2}],
             "plots": ["plot0"], "plot_style": "points",
             "compute": lambda df, p: {"plot0": parabolic_sar(df, float(p["step"]), float(p["max"]))}},
    # ── Oscillators (own pane) ──
    "rsi": {"name": "RSI", "overlay": False,
            "inputs": [{"key": "length", "label": "RSI Length", "type": "int", "default": 14, "group": "RSI Settings"},
                       {**SRCIN, "group": "RSI Settings"}] + SMOOTH_INPUTS,
            "plots": ["plot0", "ma", "bb_upper", "bb_lower"],
            "pane": {"range": [0, 100], "bands": [70, 30]},
            "compute": _compute_rsi},
    "macd": {"name": "MACD", "overlay": False,
             "inputs": [{"key": "fast", "label": "Fast Length", "type": "int", "default": 12},
                        {"key": "slow", "label": "Slow Length", "type": "int", "default": 26},
                        {"key": "signal", "label": "Signal Length", "type": "int", "default": 9}, SRCIN],
             "plots": ["hist", "plot0", "plot1"], "pane": {"bands": [0]},
             "compute": lambda df, p: (lambda ln, sg, hs: {"plot0": ln, "plot1": sg, "hist": hs})(
                 *macd(_src(df, p["source"]), int(p["fast"]), int(p["slow"]), int(p["signal"])))},
    "stoch": {"name": "Stochastic", "overlay": False,
              "inputs": [{"key": "length", "label": "%K Length", "type": "int", "default": 14},
                         {"key": "smooth", "label": "%D Smoothing", "type": "int", "default": 3}],
              "plots": ["plot0", "plot1"], "pane": {"range": [0, 100], "bands": [80, 20]},
              "compute": lambda df, p: (lambda k, d: {"plot0": k, "plot1": d})(
                  *stochastic(df, int(p["length"]), int(p["smooth"])))},
    "stochrsi": {"name": "Stochastic RSI", "overlay": False,
                 "inputs": [{"key": "rsi_len", "label": "RSI Length", "type": "int", "default": 14},
                            {"key": "stoch_len", "label": "Stoch Length", "type": "int", "default": 14}],
                 "plots": ["plot0", "plot1"], "pane": {"range": [0, 100], "bands": [80, 20]},
                 "compute": lambda df, p: (lambda k, d: {"plot0": k, "plot1": d})(
                     *stoch_rsi(_src(df, "close"), int(p["rsi_len"]), int(p["stoch_len"])))},
    "kdj": {"name": "KDJ", "overlay": False,
            "inputs": [{"key": "length", "label": "Length", "type": "int", "default": 9},
                       {"key": "k_smooth", "label": "K Smoothing", "type": "int", "default": 3},
                       {"key": "d_smooth", "label": "D Smoothing", "type": "int", "default": 3}],
            "plots": ["plot0", "plot1", "plot2"], "pane": {"bands": [80, 20]},
            "compute": lambda df, p: (lambda k, d, j: {"plot0": k, "plot1": d, "plot2": j})(
                *kdj(df, int(p["length"]), int(p["k_smooth"]), int(p["d_smooth"])))},
    "cci": {"name": "CCI", "overlay": False, "inputs": [LEN(20)], "plots": ["plot0"],
            "pane": {"bands": [100, -100]},
            "compute": lambda df, p: {"plot0": cci(df, int(p["length"]))}},
    "willr": {"name": "Williams %R", "overlay": False, "inputs": [LEN(14)], "plots": ["plot0"],
              "pane": {"range": [-100, 0], "bands": [-20, -80]},
              "compute": lambda df, p: {"plot0": williams_r(df, int(p["length"]))}},
    "roc": {"name": "Rate of Change", "overlay": False, "inputs": [LEN(12), SRCIN], "plots": ["plot0"],
            "pane": {"bands": [0]},
            "compute": lambda df, p: {"plot0": roc(_src(df, p["source"]), int(p["length"]))}},
    "mom": {"name": "Momentum", "overlay": False, "inputs": [LEN(10), SRCIN], "plots": ["plot0"],
            "pane": {"bands": [0]},
            "compute": lambda df, p: {"plot0": momentum(_src(df, p["source"]), int(p["length"]))}},
    "tsi": {"name": "TSI", "overlay": False,
            "inputs": [{"key": "long", "label": "Long Length", "type": "int", "default": 25},
                       {"key": "short", "label": "Short Length", "type": "int", "default": 13}],
            "plots": ["plot0"], "pane": {"bands": [0]},
            "compute": lambda df, p: {"plot0": tsi(_src(df, "close"), int(p["long"]), int(p["short"]))}},
    "ao": {"name": "Awesome Oscillator", "overlay": False, "inputs": [], "plots": ["hist"],
           "compute": lambda df, p: {"hist": awesome_osc(df)}},
    "adx": {"name": "ADX / DMI", "overlay": False, "inputs": [LEN(14)],
            "plots": ["plot0", "plot1", "plot2"],
            "compute": lambda df, p: (lambda pl, mi, ax: {"plot0": ax, "plot1": pl, "plot2": mi})(
                *adx_dmi(df, int(p["length"])))},
    "atr": {"name": "ATR", "overlay": False, "inputs": [LEN(14)], "plots": ["plot0"],
            "compute": lambda df, p: {"plot0": atr(df, int(p["length"]))}},
    "obv": {"name": "On Balance Volume", "overlay": False, "inputs": [], "plots": ["plot0"],
            "compute": lambda df, p: {"plot0": obv(df)}},
    "mfi": {"name": "Money Flow Index", "overlay": False, "inputs": [LEN(14)], "plots": ["plot0"],
            "pane": {"range": [0, 100], "bands": [80, 20]},
            "compute": lambda df, p: {"plot0": mfi(df, int(p["length"]))}},
    "cmf": {"name": "Chaikin Money Flow", "overlay": False, "inputs": [LEN(20)], "plots": ["plot0"],
            "pane": {"bands": [0]},
            "compute": lambda df, p: {"plot0": cmf(df, int(p["length"]))}},
}


def _apply_offset(series: pd.Series, offset: int) -> pd.Series:
    return series.shift(int(offset)) if offset else series


def compute_indicator(symbol: str, timeframe: str, ind_type: str, params: dict) -> dict:
    spec = INDICATORS.get(ind_type)
    if spec is None:
        raise ValueError(f"Unknown indicator '{ind_type}'")
    # Fill defaults for any missing params.
    full = {inp["key"]: inp["default"] for inp in spec["inputs"]}
    full.update({k: v for k, v in params.items() if v is not None})

    df = fetch_df(symbol, timeframe)
    result = spec["compute"](df, full)
    offset = int(full.get("offset", 0) or 0)

    # Compute may return fewer/more plots than declared (e.g. optional RSI
    # smoothing). Honour the declared order first, then append any extras the
    # compute produced, and skip declared keys the compute omitted.
    ordered = [k for k in spec["plots"] if k in result]
    ordered += [k for k in result.keys() if k not in ordered]

    plots = {}
    for key in ordered:
        series = result[key]
        if offset:
            series = _apply_offset(series, offset)
        arr = series.to_numpy(float) if hasattr(series, "to_numpy") else np.asarray(series, float)
        if key == "hist":
            plots[key] = hist_points(df.index, arr, (np.r_[np.nan, np.diff(arr)] >= 0))
        else:
            plots[key] = line_points(df.index, arr)

    return {
        "type": ind_type,
        "name": spec["name"],
        "overlay": bool(spec["overlay"]),
        "plots": plots,
        "plotOrder": ordered,
        "pane": spec.get("pane", {}),
        "plotStyle": spec.get("plot_style", "line"),
    }


# ═══════════════════════════ Alert engine ═════════════════════════════
# TradingView-style webhook alerts. Each alert watches a symbol/timeframe and a
# condition built from either raw price or a server-computed indicator plot.
# On every NEW BAR CLOSE for the alert's timeframe, the condition is evaluated;
# if it fires, an HTTP POST is sent to the alert's webhook URL with a
# user-editable JSON message (placeholders like {{ticker}}, {{price}} filled in).
import json
import threading

try:
    import requests as _requests
except Exception:  # noqa: BLE001
    _requests = None

_ALERTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "alerts.json")
_ALERTS_LOCK = threading.RLock()
_ALERTS: dict = {}          # id -> alert dict
_ALERT_LOG: list = []       # recent fire events (most-recent first, capped)
_ALERT_LOG_MAX = 200
_alert_seq = 0

# Comparison operators the UI offers.
ALERT_OPS = {
    "gt":   ("Greater than",        lambda a, b, pa, pb: a > b),
    "lt":   ("Less than",           lambda a, b, pa, pb: a < b),
    "gte":  ("Greater or equal",    lambda a, b, pa, pb: a >= b),
    "lte":  ("Less or equal",       lambda a, b, pa, pb: a <= b),
    "cross_up":   ("Crossing up",   lambda a, b, pa, pb: pa is not None and pa <= pb and a > b),
    "cross_down": ("Crossing down", lambda a, b, pa, pb: pa is not None and pa >= pb and a < b),
    "cross":      ("Crossing",      lambda a, b, pa, pb: pa is not None and ((pa <= pb and a > b) or (pa >= pb and a < b))),
}


def _load_alerts() -> None:
    """Load persisted alerts from disk into memory (once, at startup)."""
    global _ALERTS, _alert_seq
    try:
        with open(_ALERTS_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh) or {}
        _ALERTS = {a["id"]: a for a in data.get("alerts", []) if a.get("id")}
        _alert_seq = int(data.get("seq", 0))
    except (OSError, ValueError, KeyError):
        _ALERTS, _alert_seq = {}, 0


def _save_alerts() -> None:
    """Persist alerts to disk (called under the lock after any mutation)."""
    try:
        tmp = _ALERTS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"seq": _alert_seq, "alerts": list(_ALERTS.values())}, fh, indent=2)
        os.replace(tmp, _ALERTS_PATH)
    except OSError:
        pass


def indicator_series(symbol: str, timeframe: str, ind_type: str, params: dict) -> pd.DataFrame:
    """Compute an indicator and return its plots as a DataFrame aligned to bars.

    Reuses the exact INDICATORS registry so alert evaluation matches the chart.
    Column names are the plot keys (plot0, plot1, hist, …).
    """
    spec = INDICATORS.get(ind_type)
    if spec is None:
        raise ValueError(f"Unknown indicator '{ind_type}'")
    full = {inp["key"]: inp["default"] for inp in spec["inputs"]}
    full.update({k: v for k, v in (params or {}).items() if v is not None})
    df = fetch_df(symbol, timeframe)
    result = spec["compute"](df, full)
    offset = int(full.get("offset", 0) or 0)
    out = pd.DataFrame(index=df.index)
    for key, series in result.items():
        s = _apply_offset(series, offset) if offset else series
        out[key] = np.asarray(s, float) if not hasattr(s, "to_numpy") else s.to_numpy(float)
    return out


def _operand_series(symbol: str, timeframe: str, operand: dict) -> np.ndarray:
    """Resolve one side of a condition to a numeric numpy series over the bars.

    operand kinds:
      {"kind": "price", "source": "close"}                → OHLC price series
      {"kind": "value", "value": 123.4}                   → constant (broadcast)
      {"kind": "indicator", "type": "rsi", "plot": "plot0",
       "params": {...}}                                    → indicator plot
    """
    kind = operand.get("kind")
    if kind == "value":
        df = fetch_df(symbol, timeframe)
        return np.full(len(df), float(operand.get("value", 0.0)))
    if kind == "price":
        df = fetch_df(symbol, timeframe)
        src = (operand.get("source") or "close").capitalize()
        col = {"Open": "Open", "High": "High", "Low": "Low", "Close": "Close",
               "Hl2": None, "Hlc3": None, "Ohlc4": None}.get(src, "Close")
        if col is None:  # derived sources
            if src == "Hl2":
                return ((df["High"] + df["Low"]) / 2).to_numpy(float)
            if src == "Hlc3":
                return ((df["High"] + df["Low"] + df["Close"]) / 3).to_numpy(float)
            return ((df["Open"] + df["High"] + df["Low"] + df["Close"]) / 4).to_numpy(float)
        return df[col].to_numpy(float)
    if kind == "indicator":
        frame = indicator_series(symbol, timeframe, operand.get("type"), operand.get("params") or {})
        plot = operand.get("plot") or "plot0"
        if plot not in frame.columns:
            plot = frame.columns[0] if len(frame.columns) else None
        if plot is None:
            raise ValueError("Indicator produced no plots")
        return frame[plot].to_numpy(float)
    raise ValueError(f"Unknown operand kind '{kind}'")


def evaluate_alert(alert: dict) -> dict:
    """Evaluate an alert's condition on the LAST CLOSED bar.

    Returns {"fires": bool, "bar_time": epoch, "left": v, "right": v}.
    Uses the last two bars so crossing conditions have a previous value.
    """
    symbol = alert["symbol"]
    tf = alert["timeframe"]
    cond = alert["condition"]
    left = _operand_series(symbol, tf, cond["left"])
    right = _operand_series(symbol, tf, cond["right"])
    df = fetch_df(symbol, tf)
    ts = _epoch(df.index)
    n = min(len(left), len(right))
    if n == 0:
        return {"fires": False}
    a, b = left[n - 1], right[n - 1]
    pa = left[n - 2] if n >= 2 else None
    pb = right[n - 2] if n >= 2 else None
    if a != a or b != b:  # NaN guard
        return {"fires": False, "bar_time": int(ts[n - 1])}
    if pa is not None and (pa != pa or pb != pb):
        pa = pb = None
    op = ALERT_OPS.get(cond.get("op", "gt"))
    fires = bool(op[1](a, b, pa, pb)) if op else False
    return {"fires": fires, "bar_time": int(ts[n - 1]), "left": float(a), "right": float(b)}


def _fill_placeholders(msg: str, ctx: dict) -> str:
    out = msg or ""
    for k, v in ctx.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


def _send_webhook(alert: dict, ctx: dict) -> dict:
    """POST the alert message to its webhook. Returns a small status dict."""
    url = alert.get("webhook") or ""
    raw = _fill_placeholders(alert.get("message") or "", ctx)
    # Try to send JSON if the message parses as JSON, else send text.
    headers = {"Content-Type": "application/json"}
    payload_is_json = True
    try:
        body = json.loads(raw)
    except (ValueError, TypeError):
        payload_is_json = False
        body = raw
    if not url:
        return {"ok": False, "error": "no webhook url"}
    if _requests is None:
        return {"ok": False, "error": "requests not installed"}
    try:
        if payload_is_json:
            r = _requests.post(url, json=body, timeout=10, verify=_SSL_VERIFY)
        else:
            r = _requests.post(url, data=body.encode("utf-8"),
                               headers={"Content-Type": "text/plain"}, timeout=10, verify=_SSL_VERIFY)
        return {"ok": r.status_code < 400, "status": r.status_code}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _log_fire(alert: dict, ev: dict, sent: dict) -> None:
    entry = {
        "alert_id": alert["id"],
        "name": alert.get("name") or alert["symbol"],
        "symbol": alert["symbol"],
        "timeframe": alert["timeframe"],
        "time": datetime.now(timezone.utc).isoformat(),
        "bar_time": ev.get("bar_time"),
        "left": ev.get("left"),
        "right": ev.get("right"),
        "webhook": sent,
    }
    _ALERT_LOG.insert(0, entry)
    del _ALERT_LOG[_ALERT_LOG_MAX:]


def fire_alert(alert: dict, ev: dict) -> dict:
    """Build context, send webhook, log, and update alert bookkeeping."""
    op_label = ALERT_OPS.get(alert["condition"].get("op", "gt"), ("", None))[0]
    ctx = {
        "ticker": alert["symbol"],
        "symbol": alert["symbol"],
        "timeframe": alert["timeframe"],
        "name": alert.get("name") or alert["symbol"],
        "price": round(ev.get("left", 0.0), 4),
        "value": round(ev.get("left", 0.0), 4),
        "threshold": round(ev.get("right", 0.0), 4),
        "op": op_label,
        "time": datetime.now(timezone.utc).isoformat(),
        "bar_time": ev.get("bar_time"),
    }
    sent = _send_webhook(alert, ctx)
    _log_fire(alert, ev, sent)
    return sent


def _tf_seconds(tf: str) -> int:
    """Approx seconds per bar — controls how often a timeframe is checked."""
    return {
        "1m": 60, "2m": 120, "5m": 300, "15m": 900, "30m": 1800,
        "1h": 3600, "60m": 3600, "90m": 5400, "4h": 14400,
        "1D": 86400, "1W": 604800, "1M": 2592000,
    }.get(tf, 86400)


def _alert_worker() -> None:
    """Background loop: evaluate active alerts when their bar likely closed.

    Per-alert we track the last evaluated bar time so we only fire ONCE per new
    closed bar (TradingView 'Once per bar close' semantics). Fired one-shot
    alerts are disabled after firing; 'recurring' alerts stay active.
    """
    last_check: dict = {}
    while True:
        try:
            now = time.time()
            with _ALERTS_LOCK:
                active = [dict(a) for a in _ALERTS.values() if a.get("enabled")]
            for alert in active:
                aid = alert["id"]
                interval = max(20, _tf_seconds(alert["timeframe"]) // 12)
                if now - last_check.get(aid, 0) < interval:
                    continue
                last_check[aid] = now
                try:
                    ev = evaluate_alert(alert)
                except Exception:  # noqa: BLE001
                    continue
                bar_time = ev.get("bar_time")
                # Only act on a bar we haven't processed for this alert yet.
                with _ALERTS_LOCK:
                    live = _ALERTS.get(aid)
                    if not live or not live.get("enabled"):
                        continue
                    if bar_time is not None and live.get("last_bar") == bar_time:
                        continue
                    live["last_bar"] = bar_time
                    if ev.get("fires"):
                        live["last_fired"] = datetime.now(timezone.utc).isoformat()
                        if live.get("mode", "once") == "once":
                            live["enabled"] = False
                        fire_target = dict(live)
                    else:
                        fire_target = None
                    _save_alerts()
                if fire_target:
                    fire_alert(fire_target, ev)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(5)


# ─────────────────────────── Flask app ────────────────────────────────
app = Flask(__name__)
# Re-read templates from disk on each request so edits show up without a restart.
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True


@app.after_request
def _no_cache(resp):
    # Dev convenience: never let the browser cache our JS/HTML so edits show
    # up on a plain refresh (no hard-reload needed).
    if request.path.endswith((".js", ".css")) or request.path == "/":
        resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


@app.route("/")
def index():
    # `ver` busts the app.js cache whenever the file changes on disk.
    try:
        ver = int(os.path.getmtime(os.path.join(app.static_folder, "app.js")))
    except OSError:
        ver = int(time.time())
    return render_template("index.html", ver=ver)


@app.route("/api/data")
def api_data():
    symbol = (request.args.get("symbol") or "AAPL").strip().upper()
    timeframe = request.args.get("tf") or "1D"
    try:
        return jsonify(build_data(symbol, timeframe))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502


@app.route("/api/overview")
def api_overview():
    symbol = (request.args.get("symbol") or "AAPL").strip().upper()
    try:
        return jsonify(fetch_overview(symbol))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502


# ─────────────────────────── Screener ──────────────────────────────────
# Scans a list of tickers (the frontend's own Watchlist — nothing is stored
# server-side) and reduces each one to a BUY/SELL/NEUTRAL verdict per rule,
# using the exact same indicator math already used for charting (rsi, macd,
# sma, bollinger). No candle history is persisted — each scan just reuses
# fetch_df()'s normal 60s cache.
SCREENER_RULES = {
    "rsi": {
        "name": "RSI Oversold / Overbought",
        "defaults": {"length": 14, "oversold": 30, "overbought": 70},
    },
    "macd_cross": {
        "name": "MACD Bullish / Bearish Cross",
        "defaults": {"fast": 12, "slow": 26, "signal": 9},
    },
    "ma_cross": {
        "name": "MA Cross (Golden / Death Cross)",
        "defaults": {"fast": 50, "slow": 200},
    },
    "bb_touch": {
        "name": "Bollinger Band Touch",
        "defaults": {"length": 20, "mult": 2.0},
    },
    "stoch": {
        "name": "Stochastic Oversold / Overbought",
        "defaults": {"k_length": 14, "d_length": 3, "oversold": 20, "overbought": 80},
    },
    "williams_r": {
        "name": "Williams %R Oversold / Overbought",
        "defaults": {"length": 14, "oversold": -80, "overbought": -20},
    },
    "cci": {
        "name": "CCI Oversold / Overbought",
        "defaults": {"length": 20, "oversold": -100, "overbought": 100},
    },
    "mfi": {
        "name": "Money Flow Index (MFI)",
        "defaults": {"length": 14, "oversold": 20, "overbought": 80},
    },
    "adx_cross": {
        "name": "ADX/DMI +DI/-DI Cross",
        "defaults": {"length": 14, "min_adx": 20},
    },
    "supertrend_flip": {
        "name": "Supertrend Flip",
        "defaults": {"length": 10, "mult": 3.0},
    },
}


def _signal_rsi(df: pd.DataFrame, p: dict) -> dict:
    length = int(p["length"])
    oversold, overbought = float(p["oversold"]), float(p["overbought"])
    r = rsi(df["Close"], length)
    if r.empty or pd.isna(r.iloc[-1]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    v = round(float(r.iloc[-1]), 1)
    if v <= oversold:
        return {"verdict": "BUY", "label": f"RSI {v} (oversold)", "value": v}
    if v >= overbought:
        return {"verdict": "SELL", "label": f"RSI {v} (overbought)", "value": v}
    return {"verdict": "NEUTRAL", "label": f"RSI {v}", "value": v}


def _signal_macd_cross(df: pd.DataFrame, p: dict) -> dict:
    line, sig, _ = macd(df["Close"], int(p["fast"]), int(p["slow"]), int(p["signal"]))
    if len(line) < 2 or pd.isna(line.iloc[-1]) or pd.isna(sig.iloc[-1]) or pd.isna(line.iloc[-2]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    d_now, d_prev = line.iloc[-1] - sig.iloc[-1], line.iloc[-2] - sig.iloc[-2]
    state = "Bullish" if d_now > 0 else "Bearish"
    if d_prev <= 0 < d_now:
        return {"verdict": "BUY", "label": "Fresh bullish cross", "value": round(float(d_now), 3)}
    if d_prev >= 0 > d_now:
        return {"verdict": "SELL", "label": "Fresh bearish cross", "value": round(float(d_now), 3)}
    return {"verdict": "NEUTRAL", "label": f"{state}, no fresh cross", "value": round(float(d_now), 3)}


def _signal_ma_cross(df: pd.DataFrame, p: dict) -> dict:
    fast_n, slow_n = int(p["fast"]), int(p["slow"])
    f, s = sma(df["Close"], fast_n), sma(df["Close"], slow_n)
    if len(f) < 2 or pd.isna(f.iloc[-1]) or pd.isna(s.iloc[-1]) or pd.isna(f.iloc[-2]) or pd.isna(s.iloc[-2]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    d_now, d_prev = f.iloc[-1] - s.iloc[-1], f.iloc[-2] - s.iloc[-2]
    state = f"SMA{fast_n} {'>' if d_now > 0 else '<'} SMA{slow_n}"
    if d_prev <= 0 < d_now:
        return {"verdict": "BUY", "label": f"Golden cross (SMA{fast_n}/{slow_n})", "value": round(float(d_now), 3)}
    if d_prev >= 0 > d_now:
        return {"verdict": "SELL", "label": f"Death cross (SMA{fast_n}/{slow_n})", "value": round(float(d_now), 3)}
    return {"verdict": "NEUTRAL", "label": f"{state}, no fresh cross", "value": round(float(d_now), 3)}


def _signal_bb_touch(df: pd.DataFrame, p: dict) -> dict:
    lo, mid, hi = bollinger(df["Close"], int(p["length"]), float(p["mult"]))
    if pd.isna(hi.iloc[-1]) or pd.isna(lo.iloc[-1]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    close = float(df["Close"].iloc[-1])
    if close >= float(hi.iloc[-1]):
        return {"verdict": "SELL", "label": f"Touching upper band ({hi.iloc[-1]:.2f})", "value": close}
    if close <= float(lo.iloc[-1]):
        return {"verdict": "BUY", "label": f"Touching lower band ({lo.iloc[-1]:.2f})", "value": close}
    return {"verdict": "NEUTRAL", "label": "Inside bands", "value": close}


def _signal_stoch(df: pd.DataFrame, p: dict) -> dict:
    k, _ = stochastic(df, int(p["k_length"]), int(p["d_length"]))
    oversold, overbought = float(p["oversold"]), float(p["overbought"])
    if k.empty or pd.isna(k.iloc[-1]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    v = round(float(k.iloc[-1]), 1)
    if v <= oversold:
        return {"verdict": "BUY", "label": f"%K {v} (oversold)", "value": v}
    if v >= overbought:
        return {"verdict": "SELL", "label": f"%K {v} (overbought)", "value": v}
    return {"verdict": "NEUTRAL", "label": f"%K {v}", "value": v}


def _signal_williams_r(df: pd.DataFrame, p: dict) -> dict:
    w = williams_r(df, int(p["length"]))
    oversold, overbought = float(p["oversold"]), float(p["overbought"])
    if w.empty or pd.isna(w.iloc[-1]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    v = round(float(w.iloc[-1]), 1)
    if v <= oversold:
        return {"verdict": "BUY", "label": f"%R {v} (oversold)", "value": v}
    if v >= overbought:
        return {"verdict": "SELL", "label": f"%R {v} (overbought)", "value": v}
    return {"verdict": "NEUTRAL", "label": f"%R {v}", "value": v}


def _signal_cci(df: pd.DataFrame, p: dict) -> dict:
    c = cci(df, int(p["length"]))
    oversold, overbought = float(p["oversold"]), float(p["overbought"])
    if c.empty or pd.isna(c.iloc[-1]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    v = round(float(c.iloc[-1]), 1)
    if v <= oversold:
        return {"verdict": "BUY", "label": f"CCI {v} (oversold)", "value": v}
    if v >= overbought:
        return {"verdict": "SELL", "label": f"CCI {v} (overbought)", "value": v}
    return {"verdict": "NEUTRAL", "label": f"CCI {v}", "value": v}


def _signal_mfi(df: pd.DataFrame, p: dict) -> dict:
    m = mfi(df, int(p["length"]))
    oversold, overbought = float(p["oversold"]), float(p["overbought"])
    if m.empty or pd.isna(m.iloc[-1]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    v = round(float(m.iloc[-1]), 1)
    if v <= oversold:
        return {"verdict": "BUY", "label": f"MFI {v} (oversold)", "value": v}
    if v >= overbought:
        return {"verdict": "SELL", "label": f"MFI {v} (overbought)", "value": v}
    return {"verdict": "NEUTRAL", "label": f"MFI {v}", "value": v}


def _signal_adx_cross(df: pd.DataFrame, p: dict) -> dict:
    plus_di, minus_di, adx = adx_dmi(df, int(p["length"]))
    min_adx = float(p["min_adx"])
    if len(plus_di) < 2 or pd.isna(plus_di.iloc[-1]) or pd.isna(minus_di.iloc[-1]) or pd.isna(plus_di.iloc[-2]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    d_now, d_prev = plus_di.iloc[-1] - minus_di.iloc[-1], plus_di.iloc[-2] - minus_di.iloc[-2]
    adx_now = 0.0 if pd.isna(adx.iloc[-1]) else float(adx.iloc[-1])
    strong = adx_now >= min_adx
    state = "+DI > -DI" if d_now > 0 else "+DI < -DI"
    if d_prev <= 0 < d_now and strong:
        return {"verdict": "BUY", "label": f"Bullish DI cross (ADX {adx_now:.0f})", "value": round(float(d_now), 2)}
    if d_prev >= 0 > d_now and strong:
        return {"verdict": "SELL", "label": f"Bearish DI cross (ADX {adx_now:.0f})", "value": round(float(d_now), 2)}
    return {"verdict": "NEUTRAL", "label": f"{state}, no fresh/strong cross", "value": round(float(d_now), 2)}


def _signal_supertrend_flip(df: pd.DataFrame, p: dict) -> dict:
    st = supertrend(df, int(p["length"]), float(p["mult"]))
    if len(st) < 2 or pd.isna(st.iloc[-1]) or pd.isna(st.iloc[-2]):
        return {"verdict": "NEUTRAL", "label": "not enough history", "value": None}
    up_now = df["Close"].iloc[-1] > st.iloc[-1]
    up_prev = df["Close"].iloc[-2] > st.iloc[-2]
    if up_now and not up_prev:
        return {"verdict": "BUY", "label": "Flipped bullish", "value": round(float(st.iloc[-1]), 2)}
    if not up_now and up_prev:
        return {"verdict": "SELL", "label": "Flipped bearish", "value": round(float(st.iloc[-1]), 2)}
    return {"verdict": "NEUTRAL", "label": f"{'Bullish' if up_now else 'Bearish'}, no flip", "value": round(float(st.iloc[-1]), 2)}


_SCREENER_FUNCS = {
    "rsi": _signal_rsi,
    "macd_cross": _signal_macd_cross,
    "ma_cross": _signal_ma_cross,
    "bb_touch": _signal_bb_touch,
    "stoch": _signal_stoch,
    "williams_r": _signal_williams_r,
    "cci": _signal_cci,
    "mfi": _signal_mfi,
    "adx_cross": _signal_adx_cross,
    "supertrend_flip": _signal_supertrend_flip,
}


@app.route("/api/screener/rules")
def api_screener_rules():
    return jsonify(SCREENER_RULES)


@app.route("/api/screener")
def api_screener():
    symbols = [s.strip().upper() for s in (request.args.get("symbols") or "").split(",") if s.strip()]
    tf = request.args.get("tf") or "1D"
    rules = [r.strip() for r in (request.args.get("rules") or "").split(",") if r.strip() in _SCREENER_FUNCS]
    if not rules:
        rules = list(_SCREENER_FUNCS.keys())

    def params_for(rule_id: str) -> dict:
        out = dict(SCREENER_RULES[rule_id]["defaults"])
        for k in out:
            v = request.args.get(f"{rule_id}_{k}")
            if v is not None:
                out[k] = v
        return out

    rule_params = {r: params_for(r) for r in rules}
    min_bars = max((_rule_min_bars(r, rule_params[r]) for r in rules), default=250)
    results = []
    for sym in symbols[:200]:
        try:
            df = fetch_screener_df(sym, tf, min_bars)
            if df is None or df.empty:
                results.append({"symbol": sym, "error": "No data — check the symbol."})
                continue
            price = float(df["Close"].iloc[-1])
            prev = float(df["Close"].iloc[-2]) if len(df) > 1 else price
            change_pct = ((price - prev) / prev * 100.0) if prev else 0.0
            signals = {}
            for r in rules:
                try:
                    signals[r] = _SCREENER_FUNCS[r](df, rule_params[r])
                except Exception as e:  # noqa: BLE001
                    signals[r] = {"verdict": "NEUTRAL", "label": f"error: {e}", "value": None}
            results.append({
                "symbol": sym, "price": round(price, 4),
                "changePct": round(change_pct, 2), "signals": signals, "error": None,
            })
        except Exception as e:  # noqa: BLE001
            results.append({"symbol": sym, "error": str(e)})
    return jsonify({"timeframe": tf, "rules": rules, "results": results})


# Short-lived cache for symbol-search queries so repeated keystrokes for the
# same prefix don't re-hit Yahoo.
_SEARCH_CACHE: dict = {}
_SEARCH_TTL = 300.0


def search_symbols(query: str, limit: int = 10) -> list:
    """Proxy Yahoo Finance's symbol search → [{symbol, name, exchange, type}].

    Uses the Chrome-impersonation session (falls back to requests) so Yahoo
    doesn't block us. Returns [] on any failure — search is best-effort.
    """
    q = (query or "").strip()
    if not q:
        return []
    key = q.lower()
    cached = _SEARCH_CACHE.get(key)
    if cached is not None and (time.time() - cached[0]) < _SEARCH_TTL:
        return cached[1]

    url = "https://query2.finance.yahoo.com/v1/finance/search"
    params = {"q": q, "quotesCount": limit, "newsCount": 0,
              "listsCount": 0, "enableFuzzyQuery": "false"}
    data = {}
    try:
        if _YF_SESSION is not None:
            r = _YF_SESSION.get(url, params=params, timeout=8)
            data = r.json()
        else:
            import requests as _rq
            r = _rq.get(url, params=params, timeout=8,
                        headers={"User-Agent": "Mozilla/5.0"}, verify=_SSL_VERIFY)
            data = r.json()
    except Exception:  # noqa: BLE001
        return []

    out = []
    for it in (data.get("quotes") or []):
        sym = (it.get("symbol") or "").strip()
        if not sym:
            continue
        name = (it.get("shortname") or it.get("longname")
                or it.get("name") or "").strip()
        out.append({
            "symbol": sym,
            "name": name,
            "exchange": (it.get("exchDisp") or it.get("exchange") or "").strip(),
            "type": (it.get("quoteType") or it.get("typeDisp") or "").strip(),
        })
        if len(out) >= limit:
            break
    _SEARCH_CACHE[key] = (time.time(), out)
    return out


@app.route("/api/search")
def api_search():
    q = request.args.get("q") or ""
    try:
        return jsonify({"results": search_symbols(q)})
    except Exception as e:  # noqa: BLE001
        return jsonify({"results": [], "error": str(e)})


@app.route("/api/catalog")
def api_catalog():
    """Indicator definitions for building the UI (menu + settings dialogs)."""
    out = []
    for key, spec in INDICATORS.items():
        out.append({
            "type": key,
            "name": spec["name"],
            "overlay": bool(spec["overlay"]),
            "inputs": spec["inputs"],
            "plots": spec["plots"],
            "pane": spec.get("pane", {}),
            "plotStyle": spec.get("plot_style", "line"),
        })
    return jsonify(out)


def zigzag_pivots(df: pd.DataFrame, depth: int = 5, deviation: float = 3.0):
    """Detect alternating swing highs/lows (a ZigZag).

    A candidate pivot is a fractal high/low: its High is the max (Low is the
    min) of the `depth` bars on each side. Candidates are then filtered so
    consecutive kept pivots alternate direction and move at least `deviation`
    percent from the previous kept pivot — dropping noise. Returns a list of
    {time, price, kind} in chronological order, where kind is 'H' or 'L'.
    """
    n = len(df)
    if n < depth * 2 + 1:
        return []
    ts = _epoch(df.index)
    high = df["High"].to_numpy(float)
    low = df["Low"].to_numpy(float)

    # Collect fractal candidates.
    cands = []  # (i, price, kind)
    for i in range(depth, n - depth):
        win_hi = high[i - depth:i + depth + 1]
        win_lo = low[i - depth:i + depth + 1]
        if high[i] >= win_hi.max():
            cands.append((i, high[i], "H"))
        if low[i] <= win_lo.min():
            cands.append((i, low[i], "L"))
    if not cands:
        return []
    cands.sort(key=lambda c: (c[0], 0 if c[2] == "H" else 1))

    # Filter into an alternating ZigZag with a % deviation threshold.
    piv = []  # (i, price, kind)
    for i, price, kind in cands:
        if not piv:
            piv.append([i, price, kind])
            continue
        last_i, last_p, last_k = piv[-1]
        if kind == last_k:
            # Same direction → keep the more extreme one.
            if (kind == "H" and price > last_p) or (kind == "L" and price < last_p):
                piv[-1] = [i, price, kind]
            continue
        move = abs(price - last_p) / last_p * 100.0 if last_p else 0.0
        if move < deviation:
            continue  # not a significant swing yet
        piv.append([i, price, kind])

    return [{"time": int(ts[i]), "price": round(float(p), 4), "kind": k}
            for i, p, k in piv]


def tv_pivots(df: pd.DataFrame, lbL: int = 120, lbR: int = 5):
    """Faithful port of TradingView's Auto Fib Retracement pivot logic.

    Uses asymmetric ta.pivothigh/pivotlow(lbL, lbR): a bar is a pivot high if
    its High is the strict max over the `lbL` bars to the left and the max over
    the `lbR` bars to the right (mirror for pivot low). The large left lookback
    is what makes the detected swings big and stable. A ZigZag state machine
    then keeps an alternating sequence, replacing the current pivot when a more
    extreme same-direction pivot appears — exactly like the Pine `last_pivot`.
    Returns {time, price, kind} chronologically.
    """
    n = len(df)
    if n < lbL + lbR + 1:
        # Not enough bars for the requested window — shrink it.
        lbL = min(lbL, max(1, n // 3))
        lbR = min(lbR, max(1, n // 6))
        if n < lbL + lbR + 1:
            return []
    ts = _epoch(df.index)
    high = df["High"].to_numpy(float)
    low = df["Low"].to_numpy(float)

    def is_ph(i):
        c = high[i]
        for k in range(i - lbL, i):
            if k >= 0 and high[k] >= c:
                return False
        for k in range(i + 1, i + lbR + 1):
            if k < n and high[k] > c:
                return False
        return True

    def is_pl(i):
        c = low[i]
        for k in range(i - lbL, i):
            if k >= 0 and low[k] <= c:
                return False
        for k in range(i + 1, i + lbR + 1):
            if k < n and low[k] < c:
                return False
        return True

    # Build alternating pivot list with same-direction replacement.
    piv = []  # [i, price, kind]
    for i in range(lbL, n - lbR):
        ph, pl = is_ph(i), is_pl(i)
        if ph:
            if piv and piv[-1][2] == "H":
                if high[i] > piv[-1][1]:
                    piv[-1] = [i, high[i], "H"]
            else:
                piv.append([i, high[i], "H"])
        if pl:
            if piv and piv[-1][2] == "L":
                if low[i] < piv[-1][1]:
                    piv[-1] = [i, low[i], "L"]
            else:
                piv.append([i, low[i], "L"])

    return [{"time": int(ts[i]), "price": round(float(p), 4), "kind": k}
            for i, p, k in piv]


@app.route("/api/pivots")
def api_pivots():
    symbol = (request.args.get("symbol") or "AAPL").strip().upper()
    timeframe = request.args.get("tf") or "1D"
    # `method=tv` uses TradingView's asymmetric pivot logic (lbL/lbR).
    method = (request.args.get("method") or "").strip().lower()
    if method == "tv":
        try:
            lbL = int(request.args.get("lbL") or 120)
        except (ValueError, TypeError):
            lbL = 120
        try:
            lbR = int(request.args.get("lbR") or 5)
        except (ValueError, TypeError):
            lbR = 5
        try:
            df = fetch_df(symbol, timeframe)
            return jsonify({"pivots": tv_pivots(df, lbL, lbR)})
        except Exception as e:  # noqa: BLE001
            return jsonify({"error": str(e)}), 502
    try:
        depth = int(request.args.get("depth") or 5)
    except (ValueError, TypeError):
        depth = 5
    try:
        deviation = float(request.args.get("deviation") or 3.0)
    except (ValueError, TypeError):
        deviation = 3.0
    try:
        df = fetch_df(symbol, timeframe)
        return jsonify({"pivots": zigzag_pivots(df, depth, deviation)})
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502


@app.route("/api/indicator")
def api_indicator():
    symbol = (request.args.get("symbol") or "AAPL").strip().upper()
    timeframe = request.args.get("tf") or "1D"
    ind_type = request.args.get("type") or ""
    # All other query params are indicator inputs (strings → coerced in compute).
    params = {k: v for k, v in request.args.items() if k not in ("symbol", "tf", "type")}
    # numeric coercion where possible
    for k, v in list(params.items()):
        try:
            params[k] = float(v) if ("." in v) else int(v)
        except (ValueError, TypeError):
            pass  # leave strings (e.g. source)
    try:
        return jsonify(compute_indicator(symbol, timeframe, ind_type, params))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502


# ─────────────────────────── Alert API ────────────────────────────────
def _valid_alert(body: dict) -> tuple:
    """Return (ok, error) after light validation of an alert payload."""
    if not isinstance(body, dict):
        return False, "invalid body"
    if not (body.get("symbol") or "").strip():
        return False, "symbol is required"
    if not (body.get("webhook") or "").strip():
        return False, "webhook URL is required"
    cond = body.get("condition") or {}
    if cond.get("op") not in ALERT_OPS:
        return False, "invalid operator"
    if not isinstance(cond.get("left"), dict) or not isinstance(cond.get("right"), dict):
        return False, "condition operands are required"
    return True, ""


def _alert_meta():
    """Descriptor the UI uses to build the alert dialog: operators, price
    sources, and every indicator with its selectable plots."""
    inds = []
    for key, spec in INDICATORS.items():
        inds.append({
            "type": key, "name": spec["name"],
            "inputs": spec["inputs"], "plots": spec["plots"],
        })
    return {
        "ops": [{"id": k, "label": v[0]} for k, v in ALERT_OPS.items()],
        "sources": ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"],
        "indicators": inds,
        "placeholders": ["ticker", "symbol", "name", "timeframe",
                         "price", "value", "threshold", "op", "time", "bar_time"],
    }


@app.route("/api/alerts/meta")
def api_alerts_meta():
    return jsonify(_alert_meta())


@app.route("/api/alerts", methods=["GET"])
def api_alerts_list():
    with _ALERTS_LOCK:
        alerts = list(_ALERTS.values())
    return jsonify({"alerts": alerts, "log": _ALERT_LOG[:50]})


@app.route("/api/alerts", methods=["POST"])
def api_alerts_create():
    global _alert_seq
    body = request.get_json(silent=True) or {}
    ok, err = _valid_alert(body)
    if not ok:
        return jsonify({"error": err}), 400
    with _ALERTS_LOCK:
        _alert_seq += 1
        aid = f"al{_alert_seq}"
        alert = {
            "id": aid,
            "name": (body.get("name") or "").strip(),
            "symbol": body["symbol"].strip().upper(),
            "timeframe": body.get("timeframe") or "1D",
            "condition": body["condition"],
            "webhook": body["webhook"].strip(),
            "message": body.get("message") or "",
            "mode": body.get("mode") or "once",   # 'once' | 'recurring'
            "enabled": True,
            "created": datetime.now(timezone.utc).isoformat(),
            "last_bar": None,
            "last_fired": None,
        }
        _ALERTS[aid] = alert
        _save_alerts()
    return jsonify(alert)


@app.route("/api/alerts/<aid>", methods=["PATCH"])
def api_alerts_update(aid):
    body = request.get_json(silent=True) or {}
    with _ALERTS_LOCK:
        alert = _ALERTS.get(aid)
        if not alert:
            return jsonify({"error": "not found"}), 404
        for field in ("name", "symbol", "timeframe", "condition",
                      "webhook", "message", "mode", "enabled"):
            if field in body:
                alert[field] = body[field]
        if "symbol" in body:
            alert["symbol"] = (alert["symbol"] or "").strip().upper()
        # Re-arm when re-enabled so it can fire on the next new bar.
        if body.get("enabled"):
            alert["last_bar"] = None
        _save_alerts()
    return jsonify(alert)


@app.route("/api/alerts/<aid>", methods=["DELETE"])
def api_alerts_delete(aid):
    with _ALERTS_LOCK:
        existed = _ALERTS.pop(aid, None) is not None
        if existed:
            _save_alerts()
    return jsonify({"ok": existed})


@app.route("/api/alerts/<aid>/test", methods=["POST"])
def api_alerts_test(aid):
    """Fire the webhook immediately with current values (does not change state)."""
    with _ALERTS_LOCK:
        alert = _ALERTS.get(aid)
        if not alert:
            return jsonify({"error": "not found"}), 404
        snapshot = dict(alert)
    try:
        ev = evaluate_alert(snapshot)
    except Exception as e:  # noqa: BLE001
        ev = {"fires": False, "error": str(e)}
    sent = fire_alert(snapshot, ev)
    return jsonify({"sent": sent, "eval": ev})


@app.route("/api/alerts/preview", methods=["POST"])
def api_alerts_preview():
    """Evaluate an unsaved condition against current data (for the dialog)."""
    body = request.get_json(silent=True) or {}
    ok, err = _valid_alert({**body, "webhook": body.get("webhook") or "x"})
    if not ok:
        return jsonify({"error": err}), 400
    try:
        ev = evaluate_alert({
            "symbol": body["symbol"].strip().upper(),
            "timeframe": body.get("timeframe") or "1D",
            "condition": body["condition"],
        })
        return jsonify(ev)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502


def _port_in_use(port: int) -> bool:
    """True if something is already accepting connections on localhost:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _pid_on_port(port: int):
    """Best-effort: return the PID listening on `port` (Windows/Unix), or None."""
    try:
        if os.name == "nt":
            out = subprocess.check_output(
                ["netstat", "-ano", "-p", "TCP"], text=True, stderr=subprocess.DEVNULL)
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[0] == "TCP" and parts[3] == "LISTENING" \
                        and parts[1].endswith(f":{port}"):
                    return int(parts[-1])
        else:
            out = subprocess.check_output(
                ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                text=True, stderr=subprocess.DEVNULL)
            pids = [int(p) for p in out.split()]
            return pids[0] if pids else None
    except Exception:  # noqa: BLE001
        return None
    return None


def _reclaim_port(port: int) -> None:
    """If a stale server holds `port`, kill it so we can bind the SAME port.

    This is what keeps the app on one predictable URL instead of spawning a
    new port on every restart.
    """
    if not _port_in_use(port):
        return
    pid = _pid_on_port(port)
    if not pid or pid == os.getpid():
        return
    print(f"Port {port} busy (pid {pid}) — reclaiming it.")
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            os.kill(pid, signal.SIGKILL)
    except Exception as e:  # noqa: BLE001
        print(f"Could not reclaim port {port}: {e}")
    # Give the OS a moment to release the socket.
    for _ in range(20):
        if not _port_in_use(port):
            break
        time.sleep(0.1)


# ─────────────────────── Process lifecycle cleanup ─────────────────────
# Flask's reloader runs TWO processes: a supervisor parent and a worker
# child (WERKZEUG_RUN_MAIN=true) that actually binds the port. If the
# terminal is killed, the parent can die while the worker is orphaned and
# keeps holding the port. We guard against this three ways:
#   1) Windows Job Object with KILL_ON_JOB_CLOSE — the OS kills the worker
#      the instant the parent dies, even on a hard/unclean kill. This is the
#      real fix for "I closed the terminal but python keeps serving".
#   2) atexit + signal handlers so a graceful shutdown tears the worker down.
#   3) A PID file so the NEXT startup reaps any tree that somehow survived.
def _assign_to_kill_on_close_job(pid: int) -> bool:
    """Put `pid` in a Windows Job that dies when THIS process's handle closes.

    The job handle is kept alive for the lifetime of the (parent) process.
    When the parent exits for ANY reason — clean exit, Ctrl+C, or the OS
    force-terminating it because the terminal was closed — Windows closes the
    handle and, because of JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, kills every
    process assigned to the job (i.e. the reloader worker). Returns True on
    success. No-op on non-Windows.
    """
    if os.name != "nt" or not pid:
        return False
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in (
                "ReadOperationCount", "WriteOperationCount",
                "OtherOperationCount", "ReadTransferCount",
                "WriteTransferCount", "OtherTransferCount")]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
        JobObjectExtendedLimitInformation = 9
        PROCESS_SET_QUOTA = 0x0100
        PROCESS_TERMINATE = 0x0001

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return False
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
                job, JobObjectExtendedLimitInformation,
                ctypes.byref(info), ctypes.sizeof(info)):
            kernel32.CloseHandle(job)
            return False
        hproc = kernel32.OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if not hproc:
            kernel32.CloseHandle(job)
            return False
        ok = kernel32.AssignProcessToJobObject(job, hproc)
        kernel32.CloseHandle(hproc)
        if not ok:
            kernel32.CloseHandle(job)
            return False
        # Intentionally keep `job` alive by stashing it on a module global so
        # the handle isn't garbage-collected (which would close it early).
        global _KILL_JOB_HANDLE
        _KILL_JOB_HANDLE = job
        return True
    except Exception:  # noqa: BLE001
        return False


_KILL_JOB_HANDLE = None


def _pidfile_path(port: int) -> str:
    return os.path.join(tempfile.gettempdir(), f"litechart-{port}.pid")


def _kill_tree(pid: int) -> None:
    """Kill a process and all of its descendants, cross-platform."""
    if not pid or pid == os.getpid():
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            # Kill the process group if we can, else just the pid.
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except Exception:  # noqa: BLE001
                os.kill(pid, signal.SIGKILL)
    except Exception:  # noqa: BLE001
        pass


def _reap_previous_instance(port: int) -> None:
    """Kill a stale LiteChart parent (and its worker) from a prior run."""
    path = _pidfile_path(port)
    try:
        with open(path, "r") as fh:
            old_pid = int((fh.read() or "0").strip())
    except Exception:  # noqa: BLE001
        return
    if old_pid and old_pid != os.getpid():
        print(f"Reaping previous LiteChart instance (pid {old_pid}).")
        _kill_tree(old_pid)
        for _ in range(20):
            if not _port_in_use(port):
                break
            time.sleep(0.1)


def _write_pidfile(port: int) -> None:
    try:
        with open(_pidfile_path(port), "w") as fh:
            fh.write(str(os.getpid()))
    except Exception:  # noqa: BLE001
        pass


def _install_parent_cleanup(port: int) -> None:
    """Ensure the reloader child is torn down when the parent exits."""
    path = _pidfile_path(port)

    def _cleanup(*_args):
        # Kill our direct child (the reloader worker) and its descendants.
        # On Windows, taskkill /T on our own PID would also target us, so we
        # target the worker by finding the process holding the port instead.
        worker = _pid_on_port(port)
        if worker and worker != os.getpid():
            _kill_tree(worker)
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception:  # noqa: BLE001
            pass

    atexit.register(_cleanup)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, lambda *_a: (_cleanup(), os._exit(0)))
        except Exception:  # noqa: BLE001
            pass
    if os.name == "nt":
        try:
            signal.signal(signal.SIGBREAK, lambda *_a: (_cleanup(), os._exit(0)))
        except Exception:  # noqa: BLE001
            pass

    # Windows: attach the reloader worker to a kill-on-close Job Object so the
    # OS reaps it if the parent is force-terminated (e.g. terminal closed)
    # without a catchable signal. The reloader spawns a NEW worker on every
    # code edit, so keep watching and re-bind whenever the worker PID changes.
    if os.name == "nt":
        import threading

        def _watch_and_bind():
            bound_pid = None
            while True:
                worker = _pid_on_port(port)
                if worker and worker != os.getpid() and worker != bound_pid:
                    if _assign_to_kill_on_close_job(worker):
                        bound_pid = worker
                        print(f"Worker (pid {worker}) bound to kill-on-close job.")
                time.sleep(0.5)

        threading.Thread(target=_watch_and_bind, daemon=True).start()


if __name__ == "__main__":
    import webbrowser
    from threading import Timer

    # Fixed, reusable port (override with PORT env var). We stay on this port
    # across restarts so the URL never changes.
    port = int(os.environ.get("PORT") or 5000)
    url = f"http://127.0.0.1:{port}"

    # The reloader runs this module twice: a supervisor parent and the actual
    # worker (WERKZEUG_RUN_MAIN=true). Only reclaim the port / open the browser
    # once, in the parent, before the worker tries to bind.
    is_worker = os.environ.get("WERKZEUG_RUN_MAIN") == "true"
    if not is_worker:
        _reap_previous_instance(port)   # kill a leftover parent+worker tree
        _reclaim_port(port)             # then reclaim the port if still held
        _write_pidfile(port)            # record us so the NEXT run can reap us
        _install_parent_cleanup(port)   # tear down our worker on exit
        # Auto-opening the browser is opt-in. Set OPEN_BROWSER=1 to enable.
        if os.environ.get("OPEN_BROWSER", "").strip() in ("1", "true", "yes"):
            Timer(1.2, lambda: webbrowser.open(url)).start()
        print(f"LiteChart running at {url}  (auto-reload on edits)")
    else:
        # Only the worker actually serves requests, so run the alert scheduler
        # here (running it in the parent too would double-fire webhooks).
        _load_alerts()
        threading.Thread(target=_alert_worker, daemon=True).start()

    # debug=True enables Werkzeug's reloader: editing server.py restarts the
    # app in place on the SAME port — no manual restart, no new port.
    # Exclude site-packages and local scratch files so they don't trigger a
    # reload storm that can wedge the server.
    app.run(host="127.0.0.1", port=port, debug=True, use_reloader=True,
            exclude_patterns=["*/site-packages/*", "*_t.py", "*_hook*"],
            threaded=True)
