"""Market structure, momentum, order flow, and liquidity calculations."""

from __future__ import annotations

PIVOT_BARS = 3
CHART_BARS = 80
FLOW_BARS = 24
VOLUME_BINS = 18


def fmt_price(value: float) -> str:
    absolute = abs(value)
    if absolute >= 100:
        return f"{value:,.2f}"
    if absolute >= 1:
        return f"{value:,.3f}"
    if absolute >= 0.1:
        return f"{value:,.4f}"
    return f"{value:,.6f}"


def ema_series(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < period or period < 1:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    multiplier = 2 / (period + 1)
    previous = seed
    for index in range(period, len(values)):
        previous = values[index] * multiplier + previous * (1 - multiplier)
        out[index] = previous
    return out


def rsi_series(closes: list[float], period: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains: list[float] = []
    losses: list[float] = []
    for index in range(1, len(closes)):
        change = closes[index] - closes[index - 1]
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    average_gain = sum(gains[:period]) / period
    average_loss = sum(losses[:period]) / period

    def reading(avg_gain: float, avg_loss: float) -> float:
        if avg_loss == 0:
            return 100.0
        relative = avg_gain / avg_loss
        return 100 - (100 / (1 + relative))

    out[period] = reading(average_gain, average_loss)
    for index in range(period, len(gains)):
        average_gain = (average_gain * (period - 1) + gains[index]) / period
        average_loss = (average_loss * (period - 1) + losses[index]) / period
        out[index + 1] = reading(average_gain, average_loss)
    return out


def macd_series(closes: list[float]) -> tuple[list[float | None], list[float | None], list[float | None]]:
    fast = ema_series(closes, 12)
    slow = ema_series(closes, 26)
    macd: list[float | None] = []
    for fast_value, slow_value in zip(fast, slow):
        if fast_value is None or slow_value is None:
            macd.append(None)
        else:
            macd.append(fast_value - slow_value)
    start = next((index for index, value in enumerate(macd) if value is not None), None)
    signal: list[float | None] = [None] * len(macd)
    if start is not None:
        valid = [value for value in macd[start:] if value is not None]
        valid_signal = ema_series(valid, 9)
        for offset, value in enumerate(valid_signal):
            signal[start + offset] = value
    histogram: list[float | None] = []
    for macd_value, signal_value in zip(macd, signal):
        if macd_value is None or signal_value is None:
            histogram.append(None)
        else:
            histogram.append(macd_value - signal_value)
    return macd, signal, histogram


def detect_swings(candles: list[dict], left: int = PIVOT_BARS, right: int = PIVOT_BARS) -> list[dict]:
    swings: list[dict] = []
    if len(candles) < left + right + 1:
        return swings
    for index in range(left, len(candles) - right):
        high = candles[index]["h"]
        low = candles[index]["l"]
        left_highs = [candles[pos]["h"] for pos in range(index - left, index)]
        right_highs = [candles[pos]["h"] for pos in range(index + 1, index + right + 1)]
        left_lows = [candles[pos]["l"] for pos in range(index - left, index)]
        right_lows = [candles[pos]["l"] for pos in range(index + 1, index + right + 1)]
        if high > max(left_highs) and high >= max(right_highs):
            swings.append({"index": index, "price": high, "type": "high"})
        if low < min(left_lows) and low <= min(right_lows):
            swings.append({"index": index, "price": low, "type": "low"})
    swings.sort(key=lambda swing: (swing["index"], 0 if swing["type"] == "high" else 1))
    last_high = None
    last_low = None
    for swing in swings:
        if swing["type"] == "high":
            if last_high is not None:
                swing["relation"] = _relation(swing["price"], last_high, high=True)
            last_high = swing["price"]
        else:
            if last_low is not None:
                swing["relation"] = _relation(swing["price"], last_low, high=False)
            last_low = swing["price"]
    return swings


def _relation(current: float, previous: float, high: bool) -> str:
    if current > previous:
        return "HH" if high else "HL"
    if current < previous:
        return "LH" if high else "LL"
    return "EH" if high else "EL"


PATTERN_LABELS = {
    "HH_HL": "Higher highs, higher lows",
    "LH_LL": "Lower highs, lower lows",
    "LH_HL": "Contracting range",
    "HH_LL": "Expanding swings",
    "balanced": "Level swings",
    "unknown": "Not enough swings",
}

PATTERN_PROSE = {
    "HH_HL": "higher highs and higher lows",
    "LH_LL": "lower highs and lower lows",
    "LH_HL": "lower highs and higher lows",
    "HH_LL": "higher highs and lower lows",
    "balanced": "level swings",
    "unknown": "an unclassified sequence",
}

PATTERN_BIAS = {
    "HH_HL": "bullish",
    "LH_LL": "bearish",
    "LH_HL": "range",
    "HH_LL": "expansion",
    "balanced": "neutral",
    "unknown": "neutral",
}


def describe_structure(swings: list[dict]) -> dict:
    highs = [swing for swing in swings if swing["type"] == "high"]
    lows = [swing for swing in swings if swing["type"] == "low"]
    if len(highs) < 2 or len(lows) < 2:
        return {
            "pattern": "unknown",
            "label": PATTERN_LABELS["unknown"],
            "bias": "neutral",
            "previous": None,
            "narrative": "There are not enough swing highs and swing lows in this window to classify the sequence yet.",
            "levels": [],
            "last_high": None,
            "prev_high": None,
            "last_low": None,
            "prev_low": None,
            "recent_side": None,
        }

    last_high, prev_high = highs[-1], highs[-2]
    last_low, prev_low = lows[-1], lows[-2]
    high_rel = last_high.get("relation") or _relation(last_high["price"], prev_high["price"], high=True)
    low_rel = last_low.get("relation") or _relation(last_low["price"], prev_low["price"], high=False)
    if high_rel in {"EH", "EL"} or low_rel in {"EH", "EL"}:
        pattern = "balanced"
    else:
        pattern = f"{high_rel}_{low_rel}"
        if pattern not in PATTERN_LABELS:
            pattern = "balanced"

    labeled_highs = [swing for swing in highs if swing.get("relation")]
    labeled_lows = [swing for swing in lows if swing.get("relation")]
    previous = None
    if len(labeled_highs) >= 2 and len(labeled_lows) >= 2:
        prev_high_rel = labeled_highs[-2]["relation"]
        prev_low_rel = labeled_lows[-2]["relation"]
        if prev_high_rel in {"EH", "EL"} or prev_low_rel in {"EH", "EL"}:
            previous = "balanced"
        else:
            candidate = f"{prev_high_rel}_{prev_low_rel}"
            previous = candidate if candidate in PATTERN_LABELS else "balanced"

    recent_side = "high" if last_high["index"] > last_low["index"] else "low"
    narrative = _structure_narrative(
        pattern,
        previous,
        last_high["price"],
        prev_high["price"],
        last_low["price"],
        prev_low["price"],
        recent_side,
    )
    return {
        "pattern": pattern,
        "label": PATTERN_LABELS[pattern],
        "bias": PATTERN_BIAS[pattern],
        "previous": previous,
        "narrative": narrative,
        "levels": _levels(pattern, last_high["price"], last_low["price"]),
        "last_high": last_high["price"],
        "prev_high": prev_high["price"],
        "last_low": last_low["price"],
        "prev_low": prev_low["price"],
        "recent_side": recent_side,
    }


def _structure_narrative(
    pattern: str,
    previous: str | None,
    last_high: float,
    prev_high: float,
    last_low: float,
    prev_low: float,
    recent_side: str,
) -> str:
    openings = {
        "HH_HL": "This timeframe is printing higher highs and higher lows.",
        "LH_LL": "This timeframe is printing lower highs and lower lows.",
        "LH_HL": "This timeframe is contracting, with lower highs and higher lows.",
        "HH_LL": "This timeframe is expanding, with higher highs and lower lows.",
        "balanced": "The latest swings are level with the pair before them.",
    }
    sentences = [openings.get(pattern, "The swing sequence is mixed.")]
    sentences.append(
        f"The latest high is {fmt_price(last_high)} versus {fmt_price(prev_high)}, "
        f"and the latest low is {fmt_price(last_low)} versus {fmt_price(prev_low)}."
    )
    if recent_side == "high":
        sentences.append(f"The most recent swing is that high at {fmt_price(last_high)}.")
    else:
        sentences.append(f"The most recent swing is that low at {fmt_price(last_low)}.")
    if previous and previous in PATTERN_PROSE:
        if previous == pattern:
            sentences.append("The swing pair before this one matched, so the sequence is continuing.")
        else:
            sentences.append(
                f"The swing pair before this one was {PATTERN_PROSE[previous]}, so the structure has shifted."
            )
    return " ".join(sentences)


def _levels(pattern: str, last_high: float, last_low: float) -> list[dict]:
    if pattern == "HH_HL":
        return [
            {"label": "Last higher low", "price": last_low, "role": "hold"},
            {"label": "Last higher high", "price": last_high, "role": "clear"},
        ]
    if pattern == "LH_LL":
        return [
            {"label": "Last lower high", "price": last_high, "role": "fail"},
            {"label": "Last lower low", "price": last_low, "role": "break"},
        ]
    if pattern == "LH_HL":
        return [
            {"label": "Range high", "price": last_high, "role": "edge"},
            {"label": "Range low", "price": last_low, "role": "edge"},
        ]
    if pattern == "HH_LL":
        return [
            {"label": "Expansion high", "price": last_high, "role": "edge"},
            {"label": "Expansion low", "price": last_low, "role": "edge"},
        ]
    return [
        {"label": "Swing high", "price": last_high, "role": "edge"},
        {"label": "Swing low", "price": last_low, "role": "edge"},
    ]


def _level_read(pattern: str, last_high: float | None, last_low: float | None) -> str:
    if last_high is None or last_low is None:
        return ""
    if pattern == "HH_HL":
        return (
            f"The sequence stays intact while price holds {fmt_price(last_low)}. "
            f"A trade through {fmt_price(last_high)} would print another higher high."
        )
    if pattern == "LH_LL":
        return (
            f"The sequence stays intact while rallies fail under {fmt_price(last_high)}. "
            f"A trade through {fmt_price(last_low)} would print another lower low."
        )
    if pattern == "LH_HL":
        return (
            f"Price is compressing between {fmt_price(last_low)} and {fmt_price(last_high)}. "
            "A close outside that band is what resolves the contraction."
        )
    if pattern == "HH_LL":
        return (
            f"Highs are pushing toward {fmt_price(last_high)} while lows are pushing toward {fmt_price(last_low)}. "
            "One side has to stop making new extremes before this settles into a trend."
        )
    return (
        f"The swings to watch are {fmt_price(last_low)} and {fmt_price(last_high)}."
    )


def _rsi_block(values: list[float | None]) -> dict | None:
    current = _latest(values)
    if current is None:
        return None
    previous = _latest(values[:-3]) if len(values) > 3 else None
    if previous is None:
        slope = "flat"
    elif current - previous > 1.5:
        slope = "rising"
    elif previous - current > 1.5:
        slope = "falling"
    else:
        slope = "flat"
    if current >= 70:
        zone = "stretched above 70"
        zone_key = "overbought"
    elif current <= 30:
        zone = "stretched below 30"
        zone_key = "oversold"
    elif current >= 55:
        zone = "on the bullish side of 50"
        zone_key = "bullish"
    elif current <= 45:
        zone = "on the bearish side of 50"
        zone_key = "bearish"
    else:
        zone = "near 50"
        zone_key = "neutral"
    return {
        "value": round(current, 2),
        "slope": slope,
        "zone": zone_key,
        "narrative": f"RSI is {current:.1f} and {slope}, {zone}.",
    }


def _macd_block(
    macd: list[float | None],
    signal: list[float | None],
    histogram: list[float | None],
) -> dict | None:
    pair = _latest_pair(macd, signal)
    if pair is None:
        return None
    macd_value, signal_value, index = pair
    histogram_value = histogram[index]
    previous = None
    if index >= 1 and macd[index - 1] is not None and signal[index - 1] is not None:
        previous = (macd[index - 1], signal[index - 1])
    if previous and previous[0] <= previous[1] and macd_value > signal_value:
        state = "fresh_bullish"
    elif previous and previous[0] >= previous[1] and macd_value < signal_value:
        state = "fresh_bearish"
    elif macd_value > signal_value:
        state = "bullish"
    elif macd_value < signal_value:
        state = "bearish"
    else:
        state = "flat"
    older = histogram[index - 3] if index >= 3 else None
    trend = _histogram_trend(histogram_value, older)
    narrative = _macd_narrative(state, trend)
    tail = [round(value, 8) for value in histogram[max(0, index - 35) : index + 1] if value is not None]
    return {
        "macd": round(macd_value, 8),
        "signal": round(signal_value, 8),
        "histogram": None if histogram_value is None else round(histogram_value, 8),
        "state": state,
        "histogram_trend": trend,
        "bias": "bullish" if state in {"bullish", "fresh_bullish"} else "bearish" if state in {"bearish", "fresh_bearish"} else "neutral",
        "narrative": narrative,
        "histogram_series": tail,
    }


def _histogram_trend(current: float | None, older: float | None) -> str:
    if current is None or older is None:
        return "steady"
    if current * older < 0:
        return "flipped_positive" if current > 0 else "flipped_negative"
    if abs(current) > abs(older) * 1.05:
        return "expanding"
    if abs(current) < abs(older) * 0.95:
        return "fading"
    return "steady"


def _macd_narrative(state: str, trend: str) -> str:
    trend_text = {
        "expanding": "the histogram is expanding",
        "fading": "the histogram is fading",
        "flipped_positive": "the histogram just flipped positive",
        "flipped_negative": "the histogram just flipped negative",
        "steady": "the histogram is steady",
    }[trend]
    if state == "fresh_bullish":
        return f"MACD crossed above its signal line on the latest candle, and {trend_text}."
    if state == "fresh_bearish":
        return f"MACD crossed below its signal line on the latest candle, and {trend_text}."
    if state == "bullish":
        return f"MACD is above its signal line, and {trend_text}."
    if state == "bearish":
        return f"MACD is below its signal line, and {trend_text}."
    return f"MACD is sitting on its signal line, and {trend_text}."


def _latest(values: list[float | None]) -> float | None:
    for value in reversed(values):
        if value is not None:
            return value
    return None


def _latest_pair(
    left: list[float | None], right: list[float | None]
) -> tuple[float, float, int] | None:
    for index in range(len(left) - 1, -1, -1):
        if left[index] is not None and right[index] is not None:
            return left[index], right[index], index
    return None


def taker_flow(candles: list[dict], bars: int = FLOW_BARS) -> dict | None:
    window = candles[-bars:]
    total = sum(candle["quote_volume"] for candle in window)
    if total <= 0:
        return None
    buy = min(total, sum(candle["taker_buy_quote"] for candle in window))
    ratio = buy / total
    return {
        "buy_quote": round(buy, 2),
        "sell_quote": round(total - buy, 2),
        "buy_ratio": round(ratio, 4),
        "bars": len(window),
        "narrative": (
            f"Taker buys account for {ratio * 100:.0f}% of quote volume over the last {len(window)} candles."
        ),
    }


def volume_nodes(candles: list[dict], bins: int = VOLUME_BINS, top: int = 3) -> list[dict]:
    window = candles[-CHART_BARS:]
    if len(window) < 5:
        return []
    low = min(candle["l"] for candle in window)
    high = max(candle["h"] for candle in window)
    span = high - low
    if span <= 0:
        return []
    width = span / bins
    buckets = [{"low": low + index * width, "high": low + (index + 1) * width, "volume": 0.0} for index in range(bins)]
    for candle in window:
        typical = (candle["h"] + candle["l"] + candle["c"]) / 3
        index = min(bins - 1, max(0, int((typical - low) / width)))
        buckets[index]["volume"] += candle["quote_volume"]
    total = sum(bucket["volume"] for bucket in buckets)
    if total <= 0:
        return []
    ranked = sorted(buckets, key=lambda bucket: bucket["volume"], reverse=True)[:top]
    nodes = []
    for bucket in ranked:
        nodes.append(
            {
                "price": round((bucket["low"] + bucket["high"]) / 2, 8),
                "low": round(bucket["low"], 8),
                "high": round(bucket["high"], 8),
                "volume": round(bucket["volume"], 2),
                "share": round(bucket["volume"] / total, 4),
            }
        )
    nodes.sort(key=lambda node: node["share"], reverse=True)
    return nodes


def _node_sentence(nodes: list[dict]) -> str:
    if not nodes:
        return ""
    pieces = [f"{fmt_price(node['price'])} ({node['share'] * 100:.0f}%)" for node in nodes]
    if len(pieces) == 1:
        listed = pieces[0]
    else:
        listed = ", ".join(pieces[:-1]) + f", and {pieces[-1]}"
    return f"The heaviest traded volume in this window sits near {listed}."


def _conflict_sentence(structure_bias: str, macd_bias: str | None) -> str:
    if macd_bias == "bearish" and structure_bias == "bullish":
        return "MACD has not confirmed the higher highs: it is still below its signal line."
    if macd_bias == "bullish" and structure_bias == "bearish":
        return "MACD has not confirmed the lower lows: it is still above its signal line."
    return ""


def analyze_timeframe(candles: list[dict], interval: str, label: str) -> dict:
    closes = [candle["c"] for candle in candles]
    swings = detect_swings(candles)
    structure = describe_structure(swings)
    rsi = _rsi_block(rsi_series(closes))
    macd_line, signal_line, histogram = macd_series(closes)
    macd = _macd_block(macd_line, signal_line, histogram)
    flow = taker_flow(candles)
    nodes = volume_nodes(candles)
    insight = _compose_insight(structure, rsi, macd, flow, nodes)

    offset = max(0, len(candles) - CHART_BARS)
    chart = candles[offset:]
    visible = []
    for swing in swings:
        chart_index = swing["index"] - offset
        if chart_index < 0 or chart_index >= len(chart):
            continue
        visible.append(
            {
                "index": chart_index,
                "price": round(swing["price"], 8),
                "type": swing["type"],
                "relation": swing.get("relation"),
            }
        )
    for side in ("high", "low"):
        matching = [swing for swing in visible if swing["type"] == side and swing.get("relation")]
        for swing in matching[:-3]:
            swing["relation"] = None

    return {
        "interval": interval,
        "label": label,
        "structure": {
            "pattern": structure["pattern"],
            "label": structure["label"],
            "bias": structure["bias"],
            "previous": structure["previous"],
            "levels": [
                {"label": level["label"], "price": round(level["price"], 8), "role": level["role"]}
                for level in structure["levels"]
            ],
        },
        "rsi": None
        if rsi is None
        else {"value": rsi["value"], "slope": rsi["slope"], "zone": rsi["zone"]},
        "macd": None
        if macd is None
        else {
            "macd": macd["macd"],
            "signal": macd["signal"],
            "histogram": macd["histogram"],
            "state": macd["state"],
            "histogram_trend": macd["histogram_trend"],
            "bias": macd["bias"],
            "histogram_series": macd["histogram_series"],
        },
        "flow": None
        if flow is None
        else {
            "buy_quote": flow["buy_quote"],
            "sell_quote": flow["sell_quote"],
            "buy_ratio": flow["buy_ratio"],
            "bars": flow["bars"],
        },
        "volume_nodes": nodes,
        "insight": insight,
        "order_flow": order_flow_profile(chart),
        "candles": [
            {
                "t": candle["t"],
                "o": round(candle["o"], 8),
                "h": round(candle["h"], 8),
                "l": round(candle["l"], 8),
                "c": round(candle["c"], 8),
            }
            for candle in chart
        ],
        "swings": visible,
    }


def _compose_insight(structure: dict, rsi: dict | None, macd: dict | None, flow: dict | None, nodes: list[dict]) -> str:
    parts = [structure["narrative"]]
    if rsi:
        parts.append(rsi["narrative"])
    if macd:
        parts.append(macd["narrative"])
        conflict = _conflict_sentence(structure["bias"], macd["bias"])
        if conflict:
            parts.append(conflict)
    if flow:
        parts.append(flow["narrative"])
    level_read = _level_read(structure["pattern"], structure.get("last_high"), structure.get("last_low"))
    if level_read:
        parts.append(level_read)
    node_sentence = _node_sentence(nodes)
    if node_sentence:
        parts.append(node_sentence)
    return " ".join(part for part in parts if part)


def alignment(timeframes: list[dict]) -> dict:
    groups: dict[str, list[str]] = {}
    for timeframe in timeframes:
        groups.setdefault(timeframe["structure"]["pattern"], []).append(timeframe["label"])
    bullish = len(groups.get("HH_HL", []))
    bearish = len(groups.get("LH_LL", []))
    if bullish >= 3:
        bias = "aligned_bullish"
        badge = "Aligned up"
    elif bearish >= 3:
        bias = "aligned_bearish"
        badge = "Aligned down"
    else:
        bias = "mixed"
        badge = "Mixed"
    return {
        "bias": bias,
        "badge": badge,
        "summary": _alignment_summary(timeframes),
    }


def _alignment_summary(timeframes: list[dict]) -> str:
    groups: dict[str, list[str]] = {}
    for timeframe in timeframes:
        pattern = timeframe["structure"]["pattern"]
        groups.setdefault(pattern, []).append(timeframe["label"])
    if len(groups) == 1:
        pattern, labels = next(iter(groups.items()))
        if len(labels) == len(timeframes) and pattern in PATTERN_PROSE:
            return f"All four timeframes are printing {PATTERN_PROSE[pattern]}."
    majority = max(groups.items(), key=lambda item: len(item[1]))
    if len(majority[1]) >= 3 and majority[0] in PATTERN_PROSE:
        joined = _join_labels(majority[1])
        others = [
            f"{timeframe['label']} is printing {PATTERN_PROSE[timeframe['structure']['pattern']]}"
            for timeframe in timeframes
            if timeframe["label"] not in majority[1]
        ]
        return f"{joined} are printing {PATTERN_PROSE[majority[0]]}. " + ". ".join(others) + "."
    pieces = [
        f"{timeframe['label']} is printing {PATTERN_PROSE[timeframe['structure']['pattern']]}"
        for timeframe in timeframes
    ]
    return "The timeframes disagree. " + ". ".join(pieces) + "."


def _join_labels(labels: list[str]) -> str:
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return f"{labels[0]} and {labels[1]}"
    return ", ".join(labels[:-1]) + f", and {labels[-1]}"


def rolling_order_flow(minute_candles: list[dict], trades: list[dict]) -> dict:
    def ratio(window: list[dict]) -> tuple[float, float, float] | None:
        total = sum(candle["quote_volume"] for candle in window)
        if total <= 0:
            return None
        buy = min(total, sum(candle["taker_buy_quote"] for candle in window))
        return buy, total - buy, buy / total

    hour_window = minute_candles[-60:]
    recent_window = minute_candles[-15:]
    prior_window = minute_candles[-60:-15]
    hour = ratio(hour_window)
    recent = ratio(recent_window)
    prior = ratio(prior_window)
    buy_quote = 0.0
    sell_quote = 0.0
    for trade in trades:
        notional = float(trade["p"]) * float(trade["q"])
        if trade["m"]:
            sell_quote += notional
        else:
            buy_quote += notional
    tape_total = buy_quote + sell_quote
    tape_ratio = buy_quote / tape_total if tape_total else None
    hour_ratio = hour[2] if hour else None
    if hour_ratio is None:
        bias = "balanced"
    elif hour_ratio >= 0.55:
        bias = "buy"
    elif hour_ratio <= 0.45:
        bias = "sell"
    else:
        bias = "balanced"
    narrative = _flow_narrative(hour, len(hour_window), recent, prior, tape_ratio, len(trades))
    return {
        "hour_buy_quote": None if hour is None else round(hour[0], 2),
        "hour_sell_quote": None if hour is None else round(hour[1], 2),
        "hour_buy_ratio": None if hour_ratio is None else round(hour_ratio, 4),
        "recent_buy_ratio": None if recent is None else round(recent[2], 4),
        "prior_buy_ratio": None if prior is None else round(prior[2], 4),
        "tape_buy_ratio": None if tape_ratio is None else round(tape_ratio, 4),
        "tape_trades": len(trades),
        "bias": bias,
        "narrative": narrative,
    }


def _flow_narrative(hour, hour_bars: int, recent, prior, tape_ratio: float | None, trade_count: int) -> str:
    sentences = []
    if hour is not None:
        sentences.append(
            f"Across the last {hour_bars} one-minute candles, taker buys are {hour[2] * 100:.0f}% of quote volume "
            f"({_fmt_quote(hour[0])} bought against {_fmt_quote(hour[1])} sold)."
        )
    if recent is not None and prior is not None:
        delta = recent[2] - prior[2]
        if abs(delta) < 0.04:
            change = "in line with"
        elif delta > 0:
            change = "a stronger buy mix than"
        else:
            change = "a weaker buy mix than"
        sentences.append(
            f"The last 15 minutes are {recent[2] * 100:.0f}% buy-side, {change} the prior 45 minutes at {prior[2] * 100:.0f}%."
        )
    if tape_ratio is not None and trade_count:
        sentences.append(
            f"The latest {trade_count:,} aggregated trades on the tape are {tape_ratio * 100:.0f}% buy-side."
        )
    return " ".join(sentences)


def resting_liquidity(bids: list, asks: list) -> dict:
    bid_levels = [(float(price), float(qty)) for price, qty in bids]
    ask_levels = [(float(price), float(qty)) for price, qty in asks]
    if not bid_levels or not ask_levels:
        return {
            "narrative": "The order book was empty.",
            "bid_walls": [],
            "ask_walls": [],
        }
    best_bid = bid_levels[0][0]
    best_ask = ask_levels[0][0]
    mid = (best_bid + best_ask) / 2
    bucket = mid * 0.00015
    bid_notional = sum(price * qty for price, qty in bid_levels)
    ask_notional = sum(price * qty for price, qty in ask_levels)
    total = bid_notional + ask_notional
    imbalance = bid_notional / total if total else 0.5
    if imbalance >= 0.58:
        balance = "bid-heavy"
    elif imbalance <= 0.42:
        balance = "ask-heavy"
    else:
        balance = "roughly balanced"
    bid_walls = _clusters(bid_levels, mid, bucket)
    ask_walls = _clusters(ask_levels, mid, bucket)
    bid_span = (bid_levels[-1][0] - mid) / mid * 100
    ask_span = (ask_levels[-1][0] - mid) / mid * 100
    spread = best_ask - best_bid
    narrative = _book_narrative(
        balance,
        imbalance,
        bid_notional,
        ask_notional,
        bid_walls,
        ask_walls,
        bid_span,
        ask_span,
    )
    return {
        "mid": round(mid, 8),
        "best_bid": round(best_bid, 8),
        "best_ask": round(best_ask, 8),
        "spread": round(spread, 8),
        "spread_bps": round(spread / mid * 10000, 4) if mid else None,
        "imbalance": round(imbalance, 4),
        "balance": balance,
        "bid_notional": round(bid_notional, 2),
        "ask_notional": round(ask_notional, 2),
        "bid_span_pct": round(bid_span, 4),
        "ask_span_pct": round(ask_span, 4),
        "bid_walls": bid_walls,
        "ask_walls": ask_walls,
        "narrative": narrative,
    }


def _clusters(levels: list[tuple[float, float]], mid: float, bucket: float) -> list[dict]:
    groups: dict[float, dict] = {}
    for price, qty in levels:
        notional = price * qty
        key = round(price / bucket) * bucket if bucket else price
        group = groups.get(key)
        if group is None:
            groups[key] = {"notional": notional, "qty": qty, "vwap_num": price * notional}
        else:
            group["notional"] += notional
            group["qty"] += qty
            group["vwap_num"] += price * notional
    walls = []
    for group in groups.values():
        if group["notional"] <= 0:
            continue
        price = group["vwap_num"] / group["notional"]
        walls.append(
            {
                "price": round(price, 8),
                "qty": round(group["qty"], 6),
                "notional": round(group["notional"], 2),
                "distance_pct": round((price - mid) / mid * 100, 4),
            }
        )
    walls.sort(key=lambda wall: wall["notional"], reverse=True)
    return walls[:4]


def _book_narrative(
    balance: str,
    imbalance: float,
    bid_notional: float,
    ask_notional: float,
    bid_walls: list[dict],
    ask_walls: list[dict],
    bid_span: float,
    ask_span: float,
) -> str:
    sentences = [
        (
            f"The visible book is {balance}: {_fmt_quote(bid_notional)} rests on the bid "
            f"against {_fmt_quote(ask_notional)} on the ask ({imbalance * 100:.0f}% of resting notional is bids)."
        )
    ]
    if bid_walls:
        wall = bid_walls[0]
        sentences.append(
            f"The heaviest bid cluster is {fmt_price(wall['price'])} ({_fmt_distance(wall['distance_pct'])}, {_fmt_quote(wall['notional'])})."
        )
    if ask_walls:
        wall = ask_walls[0]
        sentences.append(
            f"The heaviest ask cluster is {fmt_price(wall['price'])} ({_fmt_distance(wall['distance_pct'])}, {_fmt_quote(wall['notional'])})."
        )
    sentences.append(
        f"That book only extends {_fmt_distance(abs(bid_span))} below mid and {_fmt_distance(abs(ask_span))} above it. "
        "Deeper liquidity is not visible in this snapshot."
    )
    return " ".join(sentences)


def _fmt_quote(value: float) -> str:
    absolute = abs(value)
    if absolute >= 1_000_000_000:
        return f"${value / 1_000_000_000:.2f}B"
    if absolute >= 1_000_000:
        return f"${value / 1_000_000:.2f}M"
    if absolute >= 1_000:
        return f"${value / 1_000:.1f}K"
    return f"${value:.0f}"


def _fmt_distance(pct: float) -> str:
    if abs(pct) < 0.1:
        return f"{pct * 100:.0f} bps"
    return f"{pct:.2f}%"


def order_heatmap(bids: list, asks: list) -> list[dict]:
    """Cluster the visible book into price bands.

    Band width is the price span of each cluster. Intensity is its size
    relative to the largest cluster, so small size can stay green and
    large size can go red.
    """
    bid_levels = [(float(price), float(price) * float(qty)) for price, qty in bids]
    ask_levels = [(float(price), float(price) * float(qty)) for price, qty in asks]
    if not bid_levels or not ask_levels:
        return []
    points = [(price, notional, "bid") for price, notional in bid_levels]
    points += [(price, notional, "ask") for price, notional in ask_levels]
    points.sort(key=lambda point: point[0])
    low = points[0][0]
    high = points[-1][0]
    span = high - low
    if span <= 0:
        span = max(high, 1.0) * 0.0001
    bin_count = 40
    step = span / bin_count
    bins = [
        {"low": low + index * step, "high": low + (index + 1) * step, "notional": 0.0, "bid": 0.0, "ask": 0.0}
        for index in range(bin_count)
    ]
    for price, notional, side in points:
        index = min(bin_count - 1, max(0, int((price - low) / step)))
        bins[index]["notional"] += notional
        bins[index][side] += notional
    groups = _cluster_order_bins([bin_item for bin_item in bins if bin_item["notional"] > 0])
    groups = _limit_groups(groups, 14)
    bands = []
    for group in groups:
        notional = sum(bin_item["notional"] for bin_item in group)
        if notional <= 0:
            continue
        bid_notional = sum(bin_item["bid"] for bin_item in group)
        ask_notional = sum(bin_item["ask"] for bin_item in group)
        if bid_notional > ask_notional * 1.15:
            side = "bid"
        elif ask_notional > bid_notional * 1.15:
            side = "ask"
        else:
            side = "mixed"
        band_low = group[0]["low"]
        band_high = group[-1]["high"]
        bands.append(
            {
                "low": round(band_low, 8),
                "high": round(band_high, 8),
                "price": round((band_low + band_high) / 2, 8),
                "notional": round(notional, 2),
                "spread": round(band_high - band_low, 8),
                "side": side,
            }
        )
    if not bands:
        return []
    largest = max(band["notional"] for band in bands) or 1.0
    bands = [band for band in bands if band["notional"] >= largest * 0.02]
    if not bands:
        return []
    largest = max(band["notional"] for band in bands) or 1.0
    for band in bands:
        band["intensity"] = round(band["notional"] / largest, 4)
    bands.sort(key=lambda band: band["price"])
    return bands


def order_profile(bids: list, asks: list, bin_count: int = 72) -> list[dict]:
    """Fine bins for the order line. Width stays the real price span and size stays the real notional."""
    bid_levels = [(float(price), float(price) * float(qty)) for price, qty in bids]
    ask_levels = [(float(price), float(price) * float(qty)) for price, qty in asks]
    if not bid_levels or not ask_levels:
        return []
    points = [(price, notional, "bid") for price, notional in bid_levels]
    points += [(price, notional, "ask") for price, notional in ask_levels]
    points.sort(key=lambda point: point[0])
    low = points[0][0]
    high = points[-1][0]
    span = high - low
    if span <= 0:
        span = max(high, 1.0) * 0.0001
    step = span / bin_count
    bins = [
        {"low": low + index * step, "high": low + (index + 1) * step, "notional": 0.0, "bid": 0.0, "ask": 0.0}
        for index in range(bin_count)
    ]
    for price, notional, side in points:
        index = min(bin_count - 1, max(0, int((price - low) / step)))
        bins[index]["notional"] += notional
        bins[index][side] += notional
    populated = [item for item in bins if item["notional"] > 0]
    if not populated:
        return []
    largest = max(item["notional"] for item in populated) or 1.0
    profile = []
    for item in populated:
        if item["notional"] < largest * 0.004:
            continue
        if item["bid"] > item["ask"] * 1.15:
            side = "bid"
        elif item["ask"] > item["bid"] * 1.15:
            side = "ask"
        else:
            side = "mixed"
        profile.append(
            {
                "low": round(item["low"], 8),
                "high": round(item["high"], 8),
                "price": round((item["low"] + item["high"]) / 2, 8),
                "notional": round(item["notional"], 2),
                "side": side,
            }
        )
    return profile


def order_flow_profile(candles: list[dict], bin_count: int = 64) -> list[dict]:
    """Spread each candle's taker buy and sell quote across the prices it traded.

    The bins cover the full high-to-low range of the candles, so the line is
    not limited to the thin visible book.
    """
    if len(candles) < 2:
        return []
    low = min(candle["l"] for candle in candles)
    high = max(candle["h"] for candle in candles)
    span = high - low
    if span <= 0:
        return []
    step = span / bin_count
    bins = [
        {"low": low + index * step, "high": low + (index + 1) * step, "buy": 0.0, "sell": 0.0}
        for index in range(bin_count)
    ]
    for candle in candles:
        total = float(candle.get("quote_volume") or 0)
        if total <= 0:
            continue
        buy = min(total, float(candle.get("taker_buy_quote") or 0))
        sell = total - buy
        candle_low = float(candle["l"])
        candle_high = float(candle["h"])
        candle_span = candle_high - candle_low
        if candle_span <= 0:
            index = min(bin_count - 1, max(0, int((candle_low - low) / step)))
            bins[index]["buy"] += buy
            bins[index]["sell"] += sell
            continue
        for item in bins:
            overlap = min(candle_high, item["high"]) - max(candle_low, item["low"])
            if overlap <= 0:
                continue
            share = overlap / candle_span
            item["buy"] += buy * share
            item["sell"] += sell * share
    populated = [item for item in bins if item["buy"] + item["sell"] > 0]
    if not populated:
        return []
    largest = max(item["buy"] + item["sell"] for item in populated) or 1.0
    profile = []
    for item in populated:
        notional = item["buy"] + item["sell"]
        if notional < largest * 0.004:
            continue
        if item["buy"] > item["sell"] * 1.15:
            side = "buy"
        elif item["sell"] > item["buy"] * 1.15:
            side = "sell"
        else:
            side = "mixed"
        profile.append(
            {
                "low": round(item["low"], 8),
                "high": round(item["high"], 8),
                "price": round((item["low"] + item["high"]) / 2, 8),
                "notional": round(notional, 2),
                "side": side,
            }
        )
    return profile


def _cluster_order_bins(bins: list[dict]) -> list[list[dict]]:
    if not bins:
        return []
    groups: list[list[dict]] = [[bins[0]]]
    for nxt in bins[1:]:
        current = groups[-1]
        average = sum(item["notional"] for item in current) / len(current)
        previous = current[-1]
        previous_side = "bid" if previous["bid"] >= previous["ask"] else "ask"
        next_side = "bid" if nxt["bid"] >= nxt["ask"] else "ask"
        side_changed = previous_side != next_side
        gap = (previous["high"] - previous["low"]) * 0.25
        gapped = nxt["low"] > previous["high"] + gap
        distinct = abs(nxt["notional"] - average) > max(average, 1.0) * 0.5
        if gapped or side_changed or (distinct and (len(current) >= 2 or nxt["notional"] > average * 1.7)):
            groups.append([nxt])
        else:
            current.append(nxt)
    return groups


def _limit_groups(groups: list[list[dict]], limit: int) -> list[list[dict]]:
    grouped = [group for group in groups if sum(item["notional"] for item in group) > 0]
    while len(grouped) > limit:
        pair_index = 0
        pair_size = float("inf")
        for index in range(len(grouped) - 1):
            size = sum(item["notional"] for item in grouped[index]) + sum(item["notional"] for item in grouped[index + 1])
            if size < pair_size:
                pair_size = size
                pair_index = index
        grouped[pair_index] = grouped[pair_index] + grouped[pair_index + 1]
        del grouped[pair_index + 1]
    return grouped


def momentum_confidence(timeframes: list[dict], flow: dict, book: dict, heatmap: list[dict]) -> dict:
    signals: list[tuple[str, float, float]] = []
    structure_weight = {"15m": 1.0, "1h": 1.35, "4h": 1.8, "1D": 2.15}
    for timeframe in timeframes:
        weight = structure_weight.get(timeframe["label"], 1.0)
        pattern = timeframe["structure"]["pattern"]
        structure_score = {"HH_HL": 1.0, "LH_LL": -1.0, "LH_HL": 0.0, "HH_LL": 0.0}.get(pattern, 0.0)
        signals.append((f"{timeframe['label']} structure", structure_score, weight))
        macd = timeframe.get("macd") or {}
        macd_score = {"bullish": 1.0, "bearish": -1.0}.get(macd.get("bias"), 0.0)
        signals.append((f"{timeframe['label']} MACD", macd_score, weight * 0.55))
        rsi = timeframe.get("rsi") or {}
        if timeframe["label"] in {"4h", "1D"} and rsi.get("value") is not None:
            signals.append((f"{timeframe['label']} RSI", _rsi_score(rsi), weight * 0.45))
    hour_ratio = flow.get("hour_buy_ratio")
    if hour_ratio is not None:
        signals.append(("order flow", max(-1.0, min(1.0, (hour_ratio - 0.5) * 2)), 1.7))
    recent = flow.get("recent_buy_ratio")
    prior = flow.get("prior_buy_ratio")
    if recent is not None and prior is not None:
        signals.append(("recent flow", max(-1.0, min(1.0, (recent - prior) * 4)), 0.7))
    imbalance = book.get("imbalance")
    if imbalance is not None:
        signals.append(("book balance", max(-1.0, min(1.0, (imbalance - 0.5) * 2)), 1.5))
    largest = max(heatmap, key=lambda band: band["notional"]) if heatmap else None
    mid = book.get("mid")
    if largest is not None and mid:
        if largest["price"] < mid:
            location_score = 1.0
        elif largest["price"] > mid:
            location_score = -1.0
        else:
            location_score = 0.0
        signals.append(("heaviest orders", location_score, 1.35))

    considered = [signal for signal in signals if abs(signal[1]) >= 0.12]
    if not considered:
        return {
            "direction": "Unclear",
            "confidence": 0,
            "reason": "There is not enough agreement across the timeframes to lean either way.",
        }
    weight_total = sum(signal[2] for signal in considered)
    bias = sum(signal[1] * signal[2] for signal in considered) / weight_total
    same_sign = [signal for signal in considered if signal[1] * bias > 0]
    agreement = sum(signal[2] for signal in same_sign) / weight_total
    confidence = int(round(min(100, max(0, abs(bias) * agreement * 100))))
    if abs(bias) < 0.12 or agreement < 0.52:
        direction = "Unclear"
    elif bias > 0:
        direction = "Up"
    else:
        direction = "Down"
    return {
        "direction": direction,
        "confidence": confidence,
        "reason": _momentum_reason(timeframes, flow, book, largest, direction, confidence),
    }


def _rsi_score(rsi: dict) -> float:
    value = rsi.get("value")
    if value is None:
        return 0.0
    if value >= 70:
        score = 0.35
    elif value <= 30:
        score = -0.35
    elif value >= 55:
        score = 0.7
    elif value <= 45:
        score = -0.7
    else:
        score = 0.0
    if rsi.get("slope") == "rising":
        score += 0.25
    elif rsi.get("slope") == "falling":
        score -= 0.25
    return max(-1.0, min(1.0, score))


def _momentum_reason(timeframes, flow, book, largest, direction, confidence) -> str:
    by_label = {timeframe["label"]: timeframe for timeframe in timeframes}
    up = [timeframe["label"] for timeframe in timeframes if timeframe["structure"]["pattern"] == "HH_HL"]
    down = [timeframe["label"] for timeframe in timeframes if timeframe["structure"]["pattern"] == "LH_LL"]
    sentences = []
    if len(up) >= 3:
        sentences.append(f"{_join_labels(up)} are making higher highs and higher lows.")
    elif len(down) >= 3:
        sentences.append(f"{_join_labels(down)} are making lower highs and lower lows.")
    elif "4h" in by_label:
        prose = PATTERN_PROSE.get(by_label["4h"]["structure"]["pattern"], "a mixed sequence")
        sentences.append(f"The 4h is printing {prose}.")
    hour_ratio = flow.get("hour_buy_ratio")
    if hour_ratio is not None:
        if hour_ratio >= 0.55:
            flow_text = "Buyers are lifting offers"
        elif hour_ratio <= 0.45:
            flow_text = "Sellers are hitting bids"
        else:
            flow_text = "Taker flow is close to even"
        recent = flow.get("recent_buy_ratio")
        prior = flow.get("prior_buy_ratio")
        if recent is not None and prior is not None and abs(recent - prior) >= 0.04:
            flow_text += ", and the last 15 minutes are " + ("stronger" if recent > prior else "weaker")
        sentences.append(flow_text + ".")
    if largest is not None and book.get("mid"):
        place = "below" if largest["price"] < book["mid"] else "above"
        sentences.append(
            f"The heaviest orders are a {_band_shape(largest)} cluster {place} price at {fmt_price(largest['price'])}."
        )
    conflict = _momentum_conflict(by_label, direction)
    if conflict:
        sentences.append(conflict)
    if direction == "Unclear":
        if conflict:
            sentences.append(f"Confidence stays at {confidence}.")
        else:
            sentences.append(f"Those pieces do not line up, so confidence stays at {confidence}.")
    else:
        way = "up" if direction == "Up" else "down"
        sentences.append(f"Taken together, the lean is {way} with {confidence} confidence.")
    return " ".join(sentences)


def _band_shape(band: dict) -> str:
    spread_pct = 0.0
    if band.get("price"):
        spread_pct = band["spread"] / band["price"] * 100
    if spread_pct < 0.08:
        return "tight"
    if spread_pct > 0.35:
        return "wide"
    return "moderate"


def _momentum_conflict(by_label: dict, direction: str) -> str:
    four_hour = by_label.get("4h")
    if not four_hour or direction == "Unclear":
        if four_hour:
            pattern = four_hour["structure"]["pattern"]
            macd_bias = (four_hour.get("macd") or {}).get("bias")
            if pattern == "HH_HL" and macd_bias == "bearish":
                return "4h structure is up, but MACD on that chart is still bearish."
            if pattern == "LH_LL" and macd_bias == "bullish":
                return "4h structure is down, but MACD on that chart is still bullish."
        return ""
    pattern = four_hour["structure"]["pattern"]
    macd_bias = (four_hour.get("macd") or {}).get("bias")
    if direction == "Up" and pattern == "LH_LL":
        return "The 4h itself is still making lower highs and lower lows, which cuts against that lean."
    if direction == "Down" and pattern == "HH_HL":
        return "The 4h itself is still making higher highs and higher lows, which cuts against that lean."
    if pattern == "HH_HL" and macd_bias == "bearish":
        return "4h structure is up, but MACD on that chart has not confirmed it."
    if pattern == "LH_LL" and macd_bias == "bullish":
        return "4h structure is down, but MACD on that chart has not confirmed it."
    return ""


def compose_findings(name: str, timeframes: list[dict], flow: dict, book: dict, heatmap: list[dict], momentum: dict) -> str:
    by_label = {timeframe["label"]: timeframe for timeframe in timeframes}
    four_hour = by_label.get("4h")
    daily = by_label.get("1D")
    sentences = [f"On the 4h, {name} is {_timeframe_clause(four_hour)}"]
    others = []
    for label in ("15m", "1h", "1D"):
        timeframe = by_label.get(label)
        if timeframe is None:
            continue
        prose = PATTERN_PROSE.get(timeframe["structure"]["pattern"], "a mixed sequence")
        others.append(f"{label} is printing {prose}")
    if others:
        sentences.append(_sentence_list(others) + ".")
    indicator_bits = []
    if four_hour:
        indicator_bits.append(_indicator_clause("4h", four_hour))
    if daily:
        indicator_bits.append(_indicator_clause("daily", daily))
    indicator_bits = [bit for bit in indicator_bits if bit]
    if indicator_bits:
        sentences.append(" ".join(indicator_bits))
    if four_hour and four_hour["structure"]["levels"]:
        watch = _watch_level(four_hour)
        if watch:
            sentences.append(watch)

    order_sentences = []
    hour_ratio = flow.get("hour_buy_ratio")
    if hour_ratio is not None:
        recent = flow.get("recent_buy_ratio")
        prior = flow.get("prior_buy_ratio")
        flow_sentence = f"About {hour_ratio * 100:.0f}% of the last hour's trades were buys."
        if recent is not None and prior is not None and abs(recent - prior) >= 0.04:
            flow_sentence += (
                " The last 15 minutes were " + ("stronger than" if recent > prior else "weaker than") + " the rest of that hour."
            )
        order_sentences.append(flow_sentence)
    if book.get("balance"):
        balance = {
            "bid-heavy": "More size is sitting on the bid than the ask.",
            "ask-heavy": "More size is sitting on the ask than the bid.",
            "roughly balanced": "Bid and ask size are close to even.",
        }.get(book["balance"], "")
        if balance:
            order_sentences.append(balance)
    if heatmap:
        largest = max(heatmap, key=lambda band: band["notional"])
        widest = max(heatmap, key=lambda band: band["spread"])
        place = "under" if book.get("mid") and largest["price"] < book["mid"] else "over"
        order_sentences.append(
            f"The largest orders are a {_band_shape(largest)} band {place} the current price, around {fmt_price(largest['price'])}."
        )
        if widest is not largest:
            order_sentences.append(
                f"The widest band, where orders are more spread out, sits around {fmt_price(widest['price'])} and is smaller in size."
                if widest["intensity"] < 0.65
                else f"Orders are also spread across a wide band around {fmt_price(widest['price'])}."
            )
    lean = momentum.get("direction", "Unclear").lower()
    confidence = momentum.get("confidence", 0)
    source = "the order book" if book.get("balance") or heatmap else "traded volume"
    if lean == "unclear":
        order_sentences.append(
            f"Put together, the timeframes and {source} do not agree on a direction. Confidence is {confidence}."
        )
    else:
        order_sentences.append(
            f"Put together, the timeframes and {source} lean {lean}. Confidence is {confidence}."
        )
    return " ".join(sentences) + "\n\n" + " ".join(order_sentences)


def _timeframe_clause(timeframe: dict | None) -> str:
    if timeframe is None:
        return "the 4h read is unavailable."
    prose = PATTERN_PROSE.get(timeframe["structure"]["pattern"], "a mixed sequence")
    levels = timeframe["structure"]["levels"]
    if len(levels) >= 2:
        prices = sorted(level["price"] for level in levels)
        return f"printing {prose}, between {fmt_price(prices[0])} and {fmt_price(prices[1])}."
    return f"printing {prose}."


def _indicator_clause(label: str, timeframe: dict) -> str:
    rsi = timeframe.get("rsi") or {}
    macd = timeframe.get("macd") or {}
    rsi_text = ""
    if rsi.get("value") is not None:
        rsi_text = f"RSI is {_rsi_words(rsi)} at {rsi['value']:.0f}"
    macd_text = ""
    if macd.get("bias") == "bullish":
        macd_text = "MACD is above its signal"
    elif macd.get("bias") == "bearish":
        macd_text = "MACD is below its signal"
    if rsi_text and macd_text:
        return f"On the {label}, {rsi_text}, and {macd_text}."
    if rsi_text:
        return f"On the {label}, {rsi_text}."
    if macd_text:
        return f"On the {label}, {macd_text}."
    return ""


def _rsi_words(rsi: dict) -> str:
    value = rsi["value"]
    if value >= 70:
        return "stretched high"
    if value <= 30:
        return "stretched low"
    if value >= 55:
        return "bullish"
    if value <= 45:
        return "bearish"
    return "neutral"


def _watch_level(timeframe: dict) -> str:
    pattern = timeframe["structure"]["pattern"]
    levels = {level["role"]: level["price"] for level in timeframe["structure"]["levels"]}
    if pattern == "HH_HL" and "hold" in levels:
        return f"That up sequence holds while price stays above {fmt_price(levels['hold'])}."
    if pattern == "LH_LL" and "fail" in levels:
        return f"That down sequence holds while rallies stay under {fmt_price(levels['fail'])}."
    if pattern == "LH_HL" and timeframe["structure"]["levels"]:
        prices = sorted(level["price"] for level in timeframe["structure"]["levels"])
        return f"A close outside {fmt_price(prices[0])} to {fmt_price(prices[1])} is what would resolve the contraction."
    return ""


def _sentence_list(items: list[str]) -> str:
    if len(items) == 1:
        return items[0].capitalize()
    if len(items) == 2:
        return f"{items[0].capitalize()}, and {items[1]}"
    return ", ".join(items[:-1]).capitalize() + f", and {items[-1]}"


def desk_summary(coins: list[dict]) -> str:
    groups = {"aligned_bullish": [], "aligned_bearish": [], "mixed": []}
    for coin in coins:
        if coin.get("error"):
            continue
        groups[coin["alignment"]["bias"]].append(coin["base"])
    if not any(groups.values()):
        return "No markets loaded."
    labels = (
        ("aligned_bullish", "aligned up"),
        ("aligned_bearish", "aligned down"),
        ("mixed", "mixed"),
    )
    parts = [
        f"{len(groups[key])} {label} ({', '.join(groups[key])})"
        for key, label in labels
        if groups[key]
    ]
    return ". ".join(parts) + "."


def self_test() -> None:
    candles = []
    for index in range(80):
        candles.append(
            {
                "t": index,
                "o": 9,
                "h": 10,
                "l": 8,
                "c": 9,
                "quote_volume": 10,
                "taker_buy_quote": 6,
            }
        )
    for index, price in ((8, 12), (24, 15), (40, 18), (56, 22)):
        candles[index]["h"] = price
    for index, price in ((16, 7), (32, 7.4), (48, 7.8), (64, 8.2)):
        candles[index]["l"] = price
    swings = detect_swings(candles)
    structure = describe_structure(swings)
    assert structure["pattern"] == "HH_HL", structure
    assert structure["previous"] == "HH_HL", structure

    down = []
    for index in range(80):
        down.append(
            {
                "t": index,
                "o": 20,
                "h": 21,
                "l": 19,
                "c": 20,
                "quote_volume": 10,
                "taker_buy_quote": 4,
            }
        )
    for index, price in ((8, 30), (24, 27), (40, 24), (56, 21)):
        down[index]["h"] = price
    for index, price in ((16, 16), (32, 14), (48, 12), (64, 10)):
        down[index]["l"] = price
    down_structure = describe_structure(detect_swings(down))
    assert down_structure["pattern"] == "LH_LL", down_structure

    rising = [float(index) for index in range(1, 50)]
    assert _latest(rsi_series(rising)) == 100
    macd, signal, _histogram = macd_series(rising)
    assert _latest(macd) > 0
    assert _latest(signal) is not None
    assert detect_swings(candles[:5]) == []
    analyzed = analyze_timeframe(candles, "1h", "1h")
    assert "higher highs and higher lows" in analyzed["insight"]
    assert analyzed["rsi"]["value"] > 0

    bids = [(f"{100 + index * 0.02:.2f}", "0.4") for index in range(12)]
    bids.append(("99.20", "90"))
    asks = [(f"{101 + index * 0.03:.2f}", "0.3") for index in range(10)]
    asks.append(("102.40", "50"))
    bands = order_heatmap(bids, asks)
    assert len(bands) >= 2
    assert max(band["spread"] for band in bands) > min(band["spread"] for band in bands)
    assert max(band["intensity"] for band in bands) == 1
    tight = min(bands, key=lambda band: band["spread"])
    assert tight["intensity"] > 0.5
    profile = order_profile(bids, asks)
    assert profile
    peak = max(profile, key=lambda row: row["notional"])
    assert abs(peak["price"] - 99.20) < 0.2
    assert len(profile) >= len(bands)

    flow_candles = []
    for index in range(8):
        flow_candles.append(
            {
                "t": index,
                "o": 10,
                "h": 12 if index < 4 else 18,
                "l": 8 if index < 4 else 14,
                "c": 11,
                "quote_volume": 80 if index < 4 else 20,
                "taker_buy_quote": 60 if index < 4 else 4,
            }
        )
    flow = order_flow_profile(flow_candles, bin_count=20)
    assert flow
    assert flow[0]["low"] <= 8.01
    assert flow[-1]["high"] >= 17.99
    heavy = max(flow, key=lambda row: row["notional"])
    assert heavy["price"] < 13
    assert heavy["side"] == "buy"


if __name__ == "__main__":
    self_test()
    print("analysis self-test passed")
