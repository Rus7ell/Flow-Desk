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
        coins = await asyncio.gather(
            *(build_coin(client, sem, spec, tickers.get(spec[0])) for spec in COINS)
        )
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
