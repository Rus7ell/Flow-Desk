"""Flow Desk server: Binance spot data, analysis, and the desk page."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from analysis import (
    alignment,
    analyze_timeframe,
    compose_findings,
    desk_summary,
    momentum_confidence,
    order_heatmap,
    order_profile,
    resting_liquidity,
    rolling_order_flow,
)

BASE = "https://data-api.binance.vision"
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
TTL_SECONDS = 45
KLINE_LIMIT = 200

COINS = [
    ("BTCUSDT", "BTC", "Bitcoin"),
    ("ETHUSDT", "ETH", "Ethereum"),
    ("SOLUSDT", "SOL", "Solana"),
    ("BNBUSDT", "BNB", "BNB"),
    ("XRPUSDT", "XRP", "XRP"),
    ("DOGEUSDT", "DOGE", "Dogecoin"),
    ("ADAUSDT", "ADA", "Cardano"),
    ("AVAXUSDT", "AVAX", "Avalanche"),
    ("LINKUSDT", "LINK", "Chainlink"),
    ("TRXUSDT", "TRX", "TRON"),
]

TIMEFRAMES = (
    ("15m", "15m"),
    ("1h", "1h"),
    ("4h", "4h"),
    ("1d", "1D"),
)

# Largest US spot fund for each coin that has one. Tickers checked against Yahoo.
ETFS = {
    "BTC": ("IBIT", "iShares Bitcoin Trust"),
    "ETH": ("ETHA", "iShares Ethereum Trust"),
    "SOL": ("BSOL", "Bitwise Solana ETF"),
    "XRP": ("XRP", "Bitwise XRP ETF"),
    "BNB": ("VBNB", "VanEck BNB ETF"),
    "DOGE": ("GDOG", "Grayscale Dogecoin Trust"),
}
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flowdesk")

app = FastAPI(title="Flow Desk")
cache: dict = {"payload": None, "at": 0.0}


async def get_json(client: httpx.AsyncClient, sem: asyncio.Semaphore, path: str, params: dict):
    delay = 0.4
    response = None
    async with sem:
        for _attempt in range(3):
            response = await client.get(path, params=params)
            if response.status_code in {418, 429, 500, 502, 503}:
                await asyncio.sleep(delay)
                delay *= 2
                continue
            response.raise_for_status()
            payload = response.json()
            if isinstance(payload, dict) and payload.get("code"):
                raise RuntimeError(payload.get("msg") or f"{path} failed")
            return payload
    if response is not None:
        response.raise_for_status()
    raise RuntimeError(f"{path} failed")


def parse_klines(raw: list) -> list[dict]:
    candles = []
    for row in raw:
        candles.append(
            {
                "t": int(row[0]),
                "o": float(row[1]),
                "h": float(row[2]),
                "l": float(row[3]),
                "c": float(row[4]),
                "quote_volume": float(row[7]),
                "taker_buy_quote": float(row[10]),
            }
        )
    return candles


async def fetch_tickers(client: httpx.AsyncClient, sem: asyncio.Semaphore) -> dict[str, dict]:
    symbols = [symbol for symbol, _base, _name in COINS]
    raw = await get_json(
        client,
        sem,
        "/api/v3/ticker/24hr",
        {"symbols": json.dumps(symbols, separators=(",", ":"))},
    )
    tickers = {}
    for row in raw:
        tickers[row["symbol"]] = {
            "last": float(row["lastPrice"]),
            "change_pct": float(row["priceChangePercent"]),
            "quote_volume": float(row["quoteVolume"]),
            "high": float(row["highPrice"]),
            "low": float(row["lowPrice"]),
        }
    return tickers


async def build_coin(client: httpx.AsyncClient, sem: asyncio.Semaphore, spec: tuple[str, str, str], ticker: dict | None):
    symbol, base, name = spec
    try:
        requests = [
            get_json(client, sem, "/api/v3/klines", {"symbol": symbol, "interval": interval, "limit": KLINE_LIMIT})
            for interval, _label in TIMEFRAMES
        ]
        requests.append(get_json(client, sem, "/api/v3/klines", {"symbol": symbol, "interval": "1m", "limit": 60}))
        requests.append(get_json(client, sem, "/api/v3/depth", {"symbol": symbol, "limit": 1000}))
        requests.append(get_json(client, sem, "/api/v3/aggTrades", {"symbol": symbol, "limit": 1000}))
        *kline_sets, minute_raw, depth, trades = await asyncio.gather(*requests)
        timeframes = [
            analyze_timeframe(parse_klines(raw), interval, label)
            for raw, (interval, label) in zip(kline_sets, TIMEFRAMES)
        ]
        minute_candles = parse_klines(minute_raw)
        four_hour = next(timeframe for timeframe in timeframes if timeframe["interval"] == "4h")
        price = ticker["last"] if ticker else four_hour["candles"][-1]["c"]
        flow = rolling_order_flow(minute_candles, trades)
        book = resting_liquidity(depth.get("bids", []), depth.get("asks", []))
        heatmap = order_heatmap(depth.get("bids", []), depth.get("asks", []))
        profile = order_profile(depth.get("bids", []), depth.get("asks", []))
        momentum = momentum_confidence(timeframes, flow, book, heatmap)
        return {
            "symbol": symbol,
            "base": base,
            "name": name,
            "price": round(price, 8),
            "change_pct": None if ticker is None else round(ticker["change_pct"], 4),
            "quote_volume": None if ticker is None else round(ticker["quote_volume"], 2),
            "high": None if ticker is None else round(ticker["high"], 8),
            "low": None if ticker is None else round(ticker["low"], 8),
            "alignment": alignment(timeframes),
            "momentum": momentum,
            "findings": compose_findings(name, timeframes, flow, book, heatmap, momentum),
            "chart": {
                "candles": four_hour["candles"],
                "swings": four_hour["swings"],
                "levels": four_hour["structure"]["levels"],
                "heatmap": heatmap,
                "profile": profile,
                "flow": four_hour.get("order_flow") or [],
            },
        }
    except Exception as exc:
        log.warning("%s failed: %s", symbol, exc)
        return {"symbol": symbol, "base": base, "name": name, "error": str(exc)}


def parse_yahoo_candles(result: dict) -> list[dict]:
    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    candles = []
    for index, ts in enumerate(timestamps):
        if index >= len(opens) or None in (opens[index], highs[index], lows[index], closes[index]):
            continue
        price = float(closes[index])
        dollar_volume = price * float(volumes[index] or 0)
        candles.append(
            {
                "t": int(ts) * 1000,
                "o": float(opens[index]),
                "h": float(highs[index]),
                "l": float(lows[index]),
                "c": price,
                "quote_volume": dollar_volume,
                # Share volume is not split into buyer and seller, so the line stays unsigned.
                "taker_buy_quote": dollar_volume / 2,
            }
        )
    return candles


def aggregate_candles(candles: list[dict], bucket_ms: int) -> list[dict]:
    grouped: dict[int, list[dict]] = {}
    order: list[int] = []
    for candle in candles:
        key = candle["t"] // bucket_ms
        bucket = grouped.get(key)
        if bucket is None:
            grouped[key] = [candle]
            order.append(key)
        else:
            bucket.append(candle)
    merged = []
    for key in order:
        rows = grouped[key]
        merged.append(
            {
                "t": rows[0]["t"],
                "o": rows[0]["o"],
                "h": max(row["h"] for row in rows),
                "l": min(row["l"] for row in rows),
                "c": rows[-1]["c"],
                "quote_volume": sum(row["quote_volume"] for row in rows),
                "taker_buy_quote": sum(row["taker_buy_quote"] for row in rows),
            }
        )
    return merged


async def fetch_yahoo(client: httpx.AsyncClient, sem: asyncio.Semaphore, symbol: str, interval: str, span: str) -> dict:
    delay = 0.4
    response = None
    async with sem:
        for _attempt in range(3):
            response = await client.get(
                f"/{symbol}",
                params={"interval": interval, "range": span, "includePrePost": "false"},
            )
            if response.status_code in {418, 429, 500, 502, 503}:
                await asyncio.sleep(delay)
                delay *= 2
                continue
            response.raise_for_status()
            payload = response.json()
            chart = payload.get("chart") or {}
            if chart.get("error"):
                message = chart["error"].get("description") or f"{symbol} chart failed"
                raise RuntimeError(message)
            result = (chart.get("result") or [None])[0]
            if not result:
                raise RuntimeError(f"{symbol} returned no candles")
            return result
    if response is not None:
        response.raise_for_status()
    raise RuntimeError(f"{symbol} chart failed")


def etf_quote(meta: dict, daily_candles: list[dict]) -> dict:
    price = meta.get("regularMarketPrice")
    if price is None and daily_candles:
        price = daily_candles[-1]["c"]
    change = None
    if price is not None and len(daily_candles) >= 2 and daily_candles[-2]["c"]:
        change = (float(price) - daily_candles[-2]["c"]) / daily_candles[-2]["c"] * 100
    volume = meta.get("regularMarketVolume")
    dollar_volume = None
    if price is not None and volume is not None:
        dollar_volume = float(price) * float(volume)
    return {
        "price": None if price is None else float(price),
        "change_pct": change,
        "quote_volume": dollar_volume,
        "high": meta.get("regularMarketDayHigh"),
        "low": meta.get("regularMarketDayLow"),
        "name": meta.get("shortName") or meta.get("longName"),
    }


async def build_etf(client: httpx.AsyncClient, sem: asyncio.Semaphore, base: str, symbol: str, fallback_name: str) -> dict:
    try:
        intraday, hourly, daily = await asyncio.gather(
            fetch_yahoo(client, sem, symbol, "15m", "60d"),
            fetch_yahoo(client, sem, symbol, "60m", "1y"),
            fetch_yahoo(client, sem, symbol, "1d", "2y"),
        )
        hourly_candles = parse_yahoo_candles(hourly)
        daily_candles = parse_yahoo_candles(daily)
        frames = {
            "15m": parse_yahoo_candles(intraday)[-200:],
            "1h": hourly_candles[-200:],
            "4h": aggregate_candles(hourly_candles, 4 * 60 * 60 * 1000)[-200:],
            "1D": daily_candles[-200:],
        }
        if any(len(frame) < 30 for frame in frames.values()):
            raise RuntimeError("not enough trading history")
        timeframes = [analyze_timeframe(frames[label], interval, label) for interval, label in TIMEFRAMES]
        four_hour = next(timeframe for timeframe in timeframes if timeframe["interval"] == "4h")
        quote = etf_quote(daily.get("meta") or {}, daily_candles)
        price = quote["price"] if quote["price"] is not None else four_hour["candles"][-1]["c"]
        empty_flow: dict = {}
        empty_book: dict = {}
        momentum = momentum_confidence(timeframes, empty_flow, empty_book, [])
        return {
            "available": True,
            "symbol": symbol,
            "base": symbol,
            "name": quote["name"] or fallback_name,
            "market": "etf",
            "coin": base,
            "price": round(price, 8),
            "change_pct": None if quote["change_pct"] is None else round(quote["change_pct"], 4),
            "quote_volume": None if quote["quote_volume"] is None else round(quote["quote_volume"], 2),
            "high": None if quote["high"] is None else round(float(quote["high"]), 8),
            "low": None if quote["low"] is None else round(float(quote["low"]), 8),
            "alignment": alignment(timeframes),
            "momentum": momentum,
            "findings": compose_findings(quote["name"] or fallback_name, timeframes, empty_flow, empty_book, [], momentum),
            "chart": {
                "candles": four_hour["candles"],
                "swings": four_hour["swings"],
                "levels": four_hour["structure"]["levels"],
                "heatmap": [],
                "profile": [],
                "flow": four_hour.get("order_flow") or [],
            },
        }
    except Exception as exc:
        log.warning("%s ETF %s failed: %s", base, symbol, exc)
        return {
            "available": True,
            "symbol": symbol,
            "base": symbol,
            "name": fallback_name,
            "market": "etf",
            "coin": base,
            "error": str(exc),
        }


def missing_etf(name: str) -> dict:
    return {
        "available": False,
        "note": f"No US spot ETF is listed for {name}.",
    }


async def attach_etfs(coins: list) -> None:
    timeout = httpx.Timeout(20.0, connect=10.0)
    headers = {"User-Agent": "Mozilla/5.0"}
    async with httpx.AsyncClient(base_url=YAHOO, timeout=timeout, headers=headers) as client:
        sem = asyncio.Semaphore(4)
        built = await asyncio.gather(
            *(build_etf(client, sem, base, symbol, name) for base, (symbol, name) in ETFS.items())
        )
    by_coin = {payload["coin"]: payload for payload in built}
    for coin in coins:
        if coin.get("error"):
            continue
        coin["etf"] = by_coin.get(coin["base"]) or missing_etf(coin["name"])


async def build_desk() -> dict:
    started = time.perf_counter()
    timeout = httpx.Timeout(20.0, connect=10.0)
    async with httpx.AsyncClient(base_url=BASE, timeout=timeout, headers={"User-Agent": "flow-desk"}) as client:
        sem = asyncio.Semaphore(8)
        try:
            tickers = await fetch_tickers(client, sem)
        except Exception as exc:
            log.warning("ticker request failed: %s", exc)
            tickers = {}
        coins = list(
            await asyncio.gather(*(build_coin(client, sem, spec, tickers.get(spec[0])) for spec in COINS))
        )
    await attach_etfs(coins)
    usable = [coin for coin in coins if not coin.get("error")]
    if not usable:
        raise RuntimeError(coins[0].get("error") if coins else "No market data returned")
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "age_seconds": 0,
        "stale": False,
        "source": "Binance spot",
        "summary": desk_summary(list(coins)),
        "coins": list(coins),
    }
    log.info("desk built in %.1fs", time.perf_counter() - started)
    return payload


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/desk")
async def desk(refresh: bool = Query(False)):
    now = time.time()
    cached = cache["payload"]
    if cached and not refresh and now - cache["at"] < TTL_SECONDS:
        return {**cached, "age_seconds": int(now - cache["at"]), "stale": False}
    try:
        payload = await build_desk()
    except Exception as exc:
        log.warning("desk build failed: %s", exc)
        if cached:
            return {**cached, "age_seconds": int(now - cache["at"]), "stale": True}
        raise HTTPException(status_code=503, detail="Market data is unavailable right now.") from exc
    cache["payload"] = payload
    cache["at"] = time.time()
    return payload


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8787)
