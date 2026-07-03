"""
LiteChart — web backend.

Serves OHLCV data (downloaded from Yahoo Finance) plus server-computed
indicators as JSON, and hosts a single-page frontend that renders everything
with TradingView Lightweight Charts (loaded from a CDN).

Run:
    conda run -n py3 python server.py
then open http://127.0.0.1:5000
"""

import os
import signal
import socket
import ssl
import subprocess
import time

# Disable SSL verification — must happen before any network import.
os.environ["PYTHONHTTPSVERIFY"] = "0"
os.environ["CURL_CA_BUNDLE"] = ""
os.environ["REQUESTS_CA_BUNDLE"] = ""
ssl._create_default_https_context = ssl._create_unverified_context

# Impersonate Chrome so Yahoo Finance doesn't block/rate-limit us.
try:
    from curl_cffi.requests import Session as CurlSession
    _YF_SESSION = CurlSession(impersonate="chrome120", verify=False, timeout=20)
except Exception:
    _YF_SESSION = None

import numpy as np
import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, render_template, request


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


def _fetch_df_uncached(symbol: str, timeframe: str) -> pd.DataFrame:
    period, interval = PERIOD_MAP.get(timeframe, ("1y", "1d"))
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
            rule = _RESAMPLE.get(timeframe)
            if rule:
                df = df.resample(rule).agg({
                    "Open": "first", "High": "max",
                    "Low": "min", "Close": "last",
                    "Volume": "sum",
                }).dropna()
            df = df[~df.index.duplicated(keep="last")].sort_index()
            return df
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            if "Rate" in last_err or "429" in last_err:
                continue
            break
    raise RuntimeError(last_err or "Unknown fetch error")


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
        _reclaim_port(port)
        # Auto-opening the browser is opt-in. Set OPEN_BROWSER=1 to enable.
        if os.environ.get("OPEN_BROWSER", "").strip() in ("1", "true", "yes"):
            Timer(1.2, lambda: webbrowser.open(url)).start()
        print(f"LiteChart running at {url}  (auto-reload on edits)")

    # debug=True enables Werkzeug's reloader: editing server.py restarts the
    # app in place on the SAME port — no manual restart, no new port.
    app.run(host="127.0.0.1", port=port, debug=True, use_reloader=True, threaded=True)
