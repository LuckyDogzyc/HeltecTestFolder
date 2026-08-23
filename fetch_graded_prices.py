#!/usr/bin/env python3
"""Fetch PSA graded prices for the in-use card watchlist from PriceCharting.

Called by the daily GitHub Action (update-pokemon-prices.yml) right after the
TCGCSV bulk card-price update. Scrapes the PUBLIC PriceCharting product pages
(search-products -> product page #price_data table) — no API token/subscription
needed. Writes cards/graded_prices.json which the server reads as its primary
source (per-card HTTP is only a server-side fallback for cards not on the list).

Usage:
    python fetch_graded_prices.py [--sleep SECONDS] [--watchlist PATH] [--out PATH]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parent
DEFAULT_WATCHLIST = ROOT / "cards" / "graded_watchlist.json"
DEFAULT_OUT = ROOT / "cards" / "graded_prices.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
SEARCH_URL = "https://www.pricecharting.com/search-products?type=prices&q="

# 公开页价格表列（Ungraded/Grade 7/8/9/9.5/PSA 10）→ 我们的 公司:分数 key
TABLE_TO_KEY = {
    "PSA 10": "PSA:10",
    "Grade 9": "PSA:9",
    "Grade 8": "PSA:8",
    "Grade 7": "PSA:7",
}

LINK_RE = re.compile(
    r'<a[^>]+href="(?:https?://(?:www\.)?pricecharting\.com)?(/game/[^"]+)"[^>]*>(.*?)</a>',
    re.S | re.I,
)
PRICE_TABLE_RE = re.compile(r'<table[^>]*id="price_data"(.*?)</table>', re.S | re.I)
THEAD_RE = re.compile(r"<thead(.*?)</thead>", re.S | re.I)
TBODY_RE = re.compile(r"<tbody(.*?)</tbody>", re.S | re.I)
TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
TH_RE = re.compile(r"<th[^>]*>(.*?)</th>", re.S | re.I)
TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S | re.I)
PRICE_RE = re.compile(r"\$([0-9][0-9,]*(?:\.[0-9]+)?)")


def norm(value: str) -> str:
    text = (value or "").lower()
    text = text.replace("&", " and ")
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", text).strip()


def parse_usd(raw: str) -> float | None:
    m = PRICE_RE.search(raw or "")
    if not m:
        return None
    try:
        n = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    return n if n > 0 else None


def parse_search_links(html: str) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in LINK_RE.finditer(html):
        href = m.group(1).replace("&amp;", "&")
        title = re.sub(r"<[^>]+>", "", m.group(2)).replace("&amp;", "&").replace("&#39;", "'").strip()
        if not title or href in seen:
            continue
        seen.add(href)
        hits.append((title, f"https://www.pricecharting.com{href}"))
        if len(hits) >= 20:
            break
    return hits


def parse_price_table(html: str) -> dict[str, float] | None:
    table_match = PRICE_TABLE_RE.search(html)
    if not table_match:
        return None
    table = table_match.group(1)
    thead = THEAD_RE.search(table)
    if not thead:
        return None
    first_header_tr = TR_RE.search(thead.group(1))
    if not first_header_tr:
        return None
    labels = [re.sub(r"<[^>]+>", " ", c).strip() for c in TH_RE.findall(first_header_tr.group(1))]

    tbody = TBODY_RE.search(table)
    if not tbody:
        return None
    first_body_tr = TR_RE.search(tbody.group(1))
    if not first_body_tr:
        return None
    cells = [c for c in TD_RE.findall(first_body_tr.group(1))]

    out: dict[str, float] = {}
    for label, cell in zip(labels, cells):
        if not label:
            continue
        price = parse_usd(cell)
        if price is not None:
            out[label] = price
    return out or None


def match_score(title: str, href: str, entry: dict) -> int:
    t = norm(title)
    base = norm(entry["name"])
    # PC 标题编号不带前导零（#6 vs 006），匹配时去掉
    num = norm(str(entry.get("num", "")).split("/")[0]).lstrip("0")
    slug = norm(href)
    score = 0
    if base and base in t:
        score += 400
    if num and num in t:
        score += 300
    for token in norm(entry.get("set", "")).split():
        if len(token) >= 4 and (token in t or token in slug):
            score += 40
    if entry.get("market") == "pokemon-jp":
        if "japanese" in slug:
            score += 50
        elif "korean" in slug or "chinese" in slug:
            score -= 100
    else:
        if "japanese" in slug or "korean" in slug or "chinese" in slug:
            score -= 50
    return score


def fetch_grades_for_card(entry: dict, session: requests.Session) -> dict:
    query = " ".join(x for x in [entry.get("name", ""), str(entry.get("num", "")).split("/")[0]] if x)[:120]
    response = session.get(
        SEARCH_URL + quote(query),
        headers={"Accept": "text/html", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )
    response.raise_for_status()
    hits = parse_search_links(response.text)
    if not hits:
        return {}
    best_title, best_href, best_score = "", "", 0
    for title, href in hits:
        score = match_score(title, href, entry)
        if score > best_score:
            best_title, best_href, best_score = title, href, score
    if best_score < 700:
        return {}

    page = session.get(
        best_href,
        headers={"Accept": "text/html", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )
    page.raise_for_status()
    table = parse_price_table(page.text)
    grades: dict[str, float] = {}
    if table:
        for label, key in TABLE_TO_KEY.items():
            if label in table:
                grades[key] = table[label]
    return grades


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch PSA graded prices for the watchlist")
    parser.add_argument("--sleep", type=float, default=1.0, help="seconds between cards (politeness)")
    parser.add_argument("--watchlist", type=Path, default=DEFAULT_WATCHLIST)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    watchlist = json.loads(args.watchlist.read_text(encoding="utf-8"))
    entries = watchlist.get("cards") or []
    if not entries:
        print("watchlist empty — nothing to do", flush=True)
        return 0

    session = requests.Session()
    result: dict[str, dict] = {}
    failures: list[str] = []
    for entry in entries:
        card_key = entry.get("cardKey", "")
        try:
            grades = fetch_grades_for_card(entry, session)
        except Exception as error:  # noqa: BLE001 — report and continue with remaining cards
            print(f"[fail] {card_key}: {error}", flush=True)
            failures.append(card_key)
            continue
        if grades:
            result[card_key] = grades
            labels = ", ".join(f"{k}=${v:,.2f}" for k, v in sorted(grades.items()))
            print(f"[ok]   {card_key} -> {labels}", flush=True)
        else:
            print(f"[miss] {card_key}: no match / no price table", flush=True)
            failures.append(card_key)
        time.sleep(args.sleep)

    payload = {"updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "prices": result}
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {args.out} ({len(result)}/{len(entries)} cards)", flush=True)
    if failures:
        print(f"unmatched/failed: {failures}", file=sys.stderr, flush=True)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
