#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 Tushare fund_share 回填 / 增量更新 ETF 每日份额。

数据口径：Tushare `fund_share` 返回基金份额（单位：万份），覆盖沪深 ETF。
  亿份 = fd_share / 10000

用法：
  python3 scripts/fetch_shares.py --days 400   # 首次回填约一年
  python3 scripts/fetch_shares.py --days 10    # 每日增量

Token 读取顺序：
  1. 环境变量 TUSHARE_TOKEN
  2. ~/.config/etf/tushare_token（一行纯文本，建议 chmod 600）

`fund_share` 需要至少 2000 Tushare 积分，积分不足会给出明确提示。
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "etfs.json"
SHARES_PATH = ROOT / "data" / "shares_history.json"
TOKEN_FILE = Path.home() / ".config" / "etf" / "tushare_token"
API_URL = "https://api.tushare.pro"


def log(msg):
    print(f"[shares] {msg}", flush=True)


def load_token():
    token = (os.environ.get("TUSHARE_TOKEN") or "").strip()
    if token:
        return token
    try:
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def tushare_call(api_name, token, params, fields=""):
    body = json.dumps(
        {"api_name": api_name, "token": token, "params": params, "fields": fields}
    ).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "etf-tracker/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"无法连接 Tushare：{exc}") from exc

    code = payload.get("code")
    if code != 0:
        msg = payload.get("msg") or "未知错误"
        if code == 40101:
            raise RuntimeError("Tushare token 无效，请检查 TUSHARE_TOKEN 或 ~/.config/etf/tushare_token")
        if code == 40203:
            raise RuntimeError("Tushare 积分不足：fund_share 需要至少 2000 积分")
        raise RuntimeError(f"Tushare 返回错误 {code}：{msg}")

    data = payload.get("data") or {}
    names = data.get("fields") or []
    return [dict(zip(names, row)) for row in (data.get("items") or [])]


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def ts_code(tcode):
    return f"{tcode[2:]}.{tcode[:2].upper()}"


def main():
    parser = argparse.ArgumentParser(description="回填 ETF 每日份额")
    parser.add_argument("--days", type=int, default=400, help="回填自然日数，默认 400")
    parser.add_argument("--codes", help="只更新指定代码，逗号分隔")
    args = parser.parse_args()

    cfg = load_json(CONFIG_PATH, None)
    if not cfg or not cfg.get("items"):
        sys.exit(f"配置为空或无法读取：{CONFIG_PATH}")

    items = cfg["items"]
    if args.codes:
        wanted = {c.strip() for c in args.codes.split(",") if c.strip()}
        items = [it for it in items if it["code"] in wanted]
        if not items:
            sys.exit("--codes 没有匹配到任何标的")

    token = load_token()
    if not token:
        sys.exit(
            "未找到 Tushare token。\n"
            "  方式一：export TUSHARE_TOKEN=...\n"
            "  方式二：mkdir -p ~/.config/etf && printf '%s' '你的token' > ~/.config/etf/tushare_token && chmod 600 ~/.config/etf/tushare_token"
        )

    today = datetime.now()
    start = (today - timedelta(days=max(args.days, 1))).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    log(f"拉取 {len(items)} 只 ETF，{start} ~ {end}（Tushare fund_share）")

    hist = load_json(SHARES_PATH, {})
    updated = 0
    failed = []

    for it in items:
        code = it["code"]
        try:
            rows = tushare_call(
                "fund_share",
                token,
                {"ts_code": ts_code(it["tcode"]), "start_date": start, "end_date": end},
                "ts_code,trade_date,fd_share",
            )
        except RuntimeError as exc:
            sys.exit(f"拉取失败：{exc}")

        count = 0
        for row in rows:
            date = str(row.get("trade_date") or "").strip()
            try:
                fd_share = float(row.get("fd_share"))
            except (TypeError, ValueError):
                continue
            if not date or fd_share <= 0:
                continue
            hist.setdefault(date, {})[code] = round(fd_share / 1e4, 4)
            count += 1

        if count:
            updated += 1
            first, last = rows[-1].get("trade_date"), rows[0].get("trade_date")
            log(f"  · {code} {count} 条（{first} ~ {last}）")
        else:
            failed.append(code)
            log(f"  ! {code} 无数据（可能不是 ETF 或区间内未更新）")
        time.sleep(0.25)

    if not updated:
        sys.exit("没有拿到任何份额数据，未写入文件")

    SHARES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(SHARES_PATH, "w", encoding="utf-8") as fh:
        json.dump(dict(sorted(hist.items())), fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")

    dates = sorted(hist)
    log(f"已写入 {SHARES_PATH.relative_to(ROOT)}：{len(dates)} 个交易日，{updated} 只更新")
    log(f"区间：{dates[0]} ~ {dates[-1]}")
    if failed:
        log(f"未取到数据：{', '.join(failed)}")


if __name__ == "__main__":
    main()
