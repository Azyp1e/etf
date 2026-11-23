#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 ETF 成交额快照 data/snapshot.js。

数据源（均为公开行情接口）：
  - 腾讯行情 qt.gtimg.cn：现价、涨跌、成交额、内外盘、场内份额、规模
  - 新浪 5 分钟 K 线 quotes.sina.cn：20 日均额、日内成交额完成比例

用法：
  python3 scripts/update_data.py

脚本只依赖 Python 标准库。收盘后运行一次即可；交易时段页面会自行拉实时行情。
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "etfs.json"
DATA_DIR = ROOT / "data"
SNAPSHOT_PATH = DATA_DIR / "snapshot.js"
SHARES_PATH = DATA_DIR / "shares_history.json"

BJ = timezone(timedelta(hours=8))
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
QUOTE_URL = "https://qt.gtimg.cn/q={codes}"
KLINE_URL = (
    "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
    "?symbol={tcode}&scale={scale}&ma=no&datalen={datalen}"
)

# 腾讯行情字段下标（以 ~ 分隔）
F_NAME, F_CODE, F_PRICE, F_PREV, F_OPEN = 1, 2, 3, 4, 5
F_OUTER, F_INNER = 7, 8
F_TIME, F_CHANGE, F_PCT, F_HIGH, F_LOW = 30, 31, 32, 33, 34
F_AMOUNT_WAN, F_TURNOVER = 37, 38
F_MKTCAP = 45
F_SHARES = 72  # 场内总份额（股），72/73/76 通常相同


def log(msg):
    print(f"[{datetime.now(BJ):%H:%M:%S}] {msg}", flush=True)


def now_bj():
    return datetime.now(BJ)


def http_get(url, encoding="utf-8", retries=3, timeout=20):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Referer": "https://finance.sina.com.cn/",
                    "Accept": "*/*",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return raw.decode(encoding, errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_err = exc
            if attempt < retries:
                time.sleep(0.8 * attempt)
    raise RuntimeError(f"请求失败 {url}: {last_err}")


def fetch_quotes(tcodes):
    """批量拉腾讯行情，返回 {tcode: fields}。"""
    text = http_get(QUOTE_URL.format(codes=",".join(tcodes)), encoding="gbk", retries=4)
    out = {}
    for tc, body in re.findall(r'v_([a-z]{2}\d{6})="([^"]*)"', text):
        out[tc] = body.split("~")
    return out


def parse_quote(fields):
    def num(idx, default=0.0):
        try:
            return float(fields[idx])
        except (IndexError, ValueError):
            return default

    def integer(idx):
        try:
            return int(float(fields[idx]))
        except (IndexError, ValueError):
            return 0

    ts = fields[F_TIME] if len(fields) > F_TIME else ""
    shares = integer(F_SHARES) or integer(73) or integer(76)
    return {
        "code": fields[F_CODE],
        "name": fields[F_NAME],
        "price": num(F_PRICE),
        "prev_close": num(F_PREV),
        "open": num(F_OPEN),
        "pct": num(F_PCT),
        "high": num(F_HIGH),
        "low": num(F_LOW),
        "amount_yi": num(F_AMOUNT_WAN) / 1e4,  # 万元 -> 亿元
        "outer_lots": integer(F_OUTER),
        "inner_lots": integer(F_INNER),
        "turnover": num(F_TURNOVER),
        "mktcap_yi": num(F_MKTCAP),
        "shares": shares,
        "shares_yi": shares / 1e8,
        "ts": ts,
        "date": ts[:8],
    }


def fetch_kline(tcode, datalen=1600, retries=3):
    url = KLINE_URL.format(tcode=tcode, scale=5, datalen=datalen)
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            text = http_get(url, retries=1, timeout=25)
            rows = json.loads(text)
            if isinstance(rows, list) and rows:
                return rows
            raise ValueError("空数据")
        except Exception as exc:  # noqa: BLE001 - 接口经常 501/返回空
            last_err = exc
            if attempt < retries:
                time.sleep(1.0 * attempt)
    raise RuntimeError(f"K 线获取失败 {tcode}: {last_err}")


def minute_grid():
    grid = []
    for start, end in ((9 * 60 + 35, 11 * 60 + 30), (13 * 60 + 5, 15 * 60)):
        m = start
        while m <= end:
            grid.append(f"{m // 60:02d}:{m % 60:02d}")
            m += 5
    return grid


GRID = minute_grid()


def build_basis(rows, today):
    """由 5 分钟 K 线算 20 日均额、日内完成比例曲线、近 30 日成交额。

    返回 (avg20_yi, shape, hist, basis_date, days_used)
    """
    days = {}
    for row in rows:
        try:
            day = row["day"][:10]
            hhmm = row["day"][11:16]
            amount = float(row.get("amount") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if amount <= 0:
            continue
        days.setdefault(day, []).append((hhmm, amount))

    complete = sorted(d for d in days if d < today)
    usable = []
    for day in complete:
        bars = sorted(days[day])
        total = sum(a for _, a in bars)
        if total <= 0 or len(bars) < 40:
            continue
        usable.append((day, bars, total))

    if len(usable) < 5:
        raise ValueError(f"完整交易日不足（仅 {len(usable)} 天）")

    window = usable[-20:]
    avg20 = sum(total for _, _, total in window) / len(window) / 1e8

    # 每个交易日在固定 48 个时点上的累计成交额占比
    ratios = []
    for _, bars, total in window:
        cum = 0.0
        idx = 0
        row_ratios = []
        for t in GRID:
            while idx < len(bars) and bars[idx][0] <= t:
                cum += bars[idx][1]
                idx += 1
            row_ratios.append(cum / total)
        ratios.append(row_ratios)

    shape = []
    for i, t in enumerate(GRID):
        avg = sum(r[i] for r in ratios) / len(ratios)
        shape.append([t, round(avg, 4)])

    hist = [
        {"date": day, "amount_yi": round(total / 1e8, 2)}
        for day, _, total in usable[-30:]
    ]
    return round(avg20, 2), shape, hist, window[-1][0], len(window)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def load_old_snapshot():
    try:
        text = SNAPSHOT_PATH.read_text(encoding="utf-8")
        match = re.search(r"window\.SNAPSHOT\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
        if match:
            return json.loads(match.group(1))
    except (OSError, ValueError):
        pass
    return {"items": []}


def main():
    parser = argparse.ArgumentParser(description="生成 ETF 成交额快照")
    parser.add_argument("--codes", help="只更新指定代码，逗号分隔（调试用）")
    args = parser.parse_args()

    cfg = load_json(CONFIG_PATH, None)
    if not cfg or not cfg.get("items"):
        sys.exit(f"配置为空或无法读取：{CONFIG_PATH}")

    items_cfg = cfg["items"]
    if args.codes:
        wanted = {c.strip() for c in args.codes.split(",") if c.strip()}
        items_cfg = [it for it in items_cfg if it["code"] in wanted]
        if not items_cfg:
            sys.exit("--codes 没有匹配到任何标的")

    old = load_old_snapshot()
    old_by_code = {it.get("code"): it for it in old.get("items", [])}
    shares_hist = load_json(SHARES_PATH, {})

    tcodes = [it["tcode"] for it in items_cfg]
    log(f"拉取行情：{len(tcodes)} 只")
    quotes = fetch_quotes(tcodes)
    if not quotes:
        sys.exit("腾讯行情返回为空，稍后重试")

    today = max((q[F_TIME][:8] for q in quotes.values() if len(q) > F_TIME), default="")
    today = today or f"{now_bj():%Y%m%d}"
    today_dash = f"{today[:4]}-{today[4:6]}-{today[6:8]}"
    log(f"快照交易日：{today_dash}")

    items = []
    failed = []
    for conf in items_cfg:
        code, tcode = conf["code"], conf["tcode"]
        raw = quotes.get(tcode)
        if not raw:
            log(f"  ! {code} 无行情，跳过")
            failed.append(code)
            continue

        q = parse_quote(raw)
        if not q["date"]:
            q["date"] = today
        old_item = old_by_code.get(code, {})

        try:
            rows = fetch_kline(tcode)
            avg20, shape, hist, basis_date, days_used = build_basis(rows, q["date"])
            basis_stale = False
            log(f"  · {code} 20 日均额 {avg20:.2f} 亿（{days_used} 天）")
        except Exception as exc:  # noqa: BLE001
            log(f"  ! {code} K 线失败，沿用旧基准：{exc}")
            avg20 = old_item.get("avg20_yi", 0) or 0
            shape = old_item.get("shape", [])
            hist = old_item.get("hist", [])
            basis_date = old_item.get("basis_date", "")
            basis_stale = True
            failed.append(code)

        prev_shares = None
        for d in sorted(shares_hist, reverse=True):
            if d < q["date"] and code in shares_hist[d]:
                prev_shares = shares_hist[d][code]
                break

        shares_yi = round(q["shares_yi"], 4)
        subscr = None
        if prev_shares and q["shares"] and q["price"]:
            subscr = round((q["shares"] - prev_shares * 1e8) * q["price"] / 1e8, 2)

        # 只记录收盘后的份额，避免盘中不完整的快照污染次日申赎计算
        now = now_bj()
        after_close = now.hour * 60 + now.minute >= 15 * 60 + 5
        if q["date"] != f"{now:%Y%m%d}" or after_close:
            row = shares_hist.setdefault(q["date"], {})
            # Tushare 已经写入的收盘份额优先，避免被行情商的滞后份额覆盖
            if code not in row:
                row[code] = shares_yi

        items.append(
            {
                "code": code,
                "tcode": tcode,
                "name": conf.get("name") or q["name"],
                "index": conf.get("index", ""),
                "group": conf.get("group", "extended"),
                "price": round(q["price"], 3),
                "prev_close": round(q["prev_close"], 3),
                "open": round(q["open"], 3),
                "high": round(q["high"], 3),
                "low": round(q["low"], 3),
                "pct": round(q["pct"], 2),
                "amount_yi": round(q["amount_yi"], 2),
                "avg20_yi": round(avg20, 2),
                "outer_lots": q["outer_lots"],
                "inner_lots": q["inner_lots"],
                "turnover": round(q["turnover"], 2),
                "mktcap_yi": round(q["mktcap_yi"], 2),
                "shares": q["shares"],
                "shares_yi": shares_yi,
                "prev_shares_yi": prev_shares,
                "subscr_net_yi": subscr,
                "shares_stale": False,
                "ts": q["ts"],
                "date": q["date"],
                "shape": shape,
                "hist": hist,
                "basis_date": basis_date,
                "basis_stale": basis_stale,
            }
        )

    if not items:
        sys.exit("没有任何可用数据，未写入快照")

    items.sort(key=lambda it: (0 if it["group"] == "core" else 1, -it["mktcap_yi"]))

    # 份额源自检：同一市场 ≥70% 的标的两日份额完全相同，通常不是“没有申赎”，
    # 而是行情商的份额字段没有按日更新。此时不展示数字，避免误导。
    for prefix in ("sh", "sz"):
        group = [
            it for it in items
            if it["tcode"].startswith(prefix) and it.get("prev_shares_yi")
        ]
        if len(group) < 2:
            continue
        same = sum(
            1 for it in group
            if abs(it["shares_yi"] - it["prev_shares_yi"]) < 1e-6
        )
        if same / len(group) >= 0.7:
            for it in group:
                it["subscr_net_yi"] = None
                it["shares_stale"] = True
            log(f"  ! {prefix} 市场 {same}/{len(group)} 只份额与上一快照相同，标记「份额源未日更」")

    snapshot = {
        "generated_at": f"{now_bj():%Y-%m-%d %H:%M:%S}",
        "trade_date": today_dash,
        "timezone": "Asia/Shanghai",
        "source": "腾讯行情 qt.gtimg.cn + 新浪 5 分钟 K 线 quotes.sina.cn",
        "title": cfg.get("title", "ETF 成交额追踪"),
        "items": items,
        "shares_history": shares_hist,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SNAPSHOT_PATH.write_text(
        "window.SNAPSHOT = " + json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    SHARES_PATH.write_text(
        json.dumps(shares_hist, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    log(f"已写入 {SNAPSHOT_PATH.relative_to(ROOT)}（{len(items)} 只）")
    if failed:
        log(f"以下标的使用了旧基准或缺失：{', '.join(failed)}")


if __name__ == "__main__":
    main()
