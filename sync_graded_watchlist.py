#!/usr/bin/env python3
"""Sync cards/graded_watchlist.json from the devices actually in use.

The graded-price watchlist should always equal the set of cards currently
shown on devices. This script derives it from the server SQLite
(devices.card_key, deduped), regenerates the watchlist JSON, and pushes it
so the daily GitHub Action fetches PSA prices for exactly those cards.

Cards are added automatically when a card is saved to a device and removed
automatically when no device uses it anymore.

Usage:
    python sync_graded_watchlist.py [--dry-run] [--db PATH]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "server" / "data" / "pokemon-display.sqlite"
WATCHLIST = ROOT / "cards" / "graded_watchlist.json"

DESCRIPTION = "每日 GitHub Action 抓取 PSA 评级价的在用卡清单（由服务器从设备在用卡自动同步生成，请勿手改）。"

MARKET_BY_SOURCE = {
    "tcgcsv-pokemon-jp": "pokemon-jp",
    "tcgcsv-pokemon-us": "pokemon-us",
}


def load_index(market: str) -> list[dict]:
    filename = "search_index.jp.min.json" if market == "pokemon-jp" else "search_index.us.min.json"
    data = json.loads((ROOT / "cards" / filename).read_text(encoding="utf-8"))
    return data.get("cards") or []


def parse_card_key(card_key: str) -> tuple[str, int, str] | None:
    parts = card_key.split(":")
    if len(parts) < 3:
        return None
    try:
        return parts[0], int(parts[1]), parts[2]
    except ValueError:
        return None


def build_watchlist(entries: list[dict]) -> dict:
    seen: set[str] = set()
    cards: list[dict] = []
    for entry in entries:
        key = entry["cardKey"]
        if key in seen:
            continue
        seen.add(key)
        cards.append(entry)
    cards.sort(key=lambda c: c["cardKey"])
    return {"description": DESCRIPTION, "cards": cards}


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync graded watchlist from devices in use")
    parser.add_argument("--dry-run", action="store_true", help="preview without writing/committing")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1

    con = sqlite3.connect(args.db)
    rows = con.execute(
        "SELECT DISTINCT card_key FROM devices WHERE card_key IS NOT NULL AND card_key != ''"
    ).fetchall()
    con.close()
    card_keys = [row[0] for row in rows]
    if not card_keys:
        print("no in-use cards in DB — keeping existing watchlist", file=sys.stderr)
        return 1

    indexes: dict[str, list[dict]] = {}
    entries: list[dict] = []
    missing: list[str] = []
    for card_key in card_keys:
        parsed = parse_card_key(card_key)
        if not parsed:
            missing.append(card_key)
            continue
        source_id, product_id, variant = parsed
        market = MARKET_BY_SOURCE.get(source_id)
        if not market:
            missing.append(card_key)
            continue
        if market not in indexes:
            indexes[market] = load_index(market)
        card = next(
            (c for c in indexes[market] if c.get("id") == product_id and (c.get("t") or "default") == variant),
            None,
        )
        if not card:
            missing.append(card_key)
            continue
        n = card.get("n") or ""
        entries.append(
            {
                "cardKey": card_key,
                "name": n.split(" - ")[0].strip() or n,
                "num": card.get("num") or "",
                "set": card.get("s") or "",
                "market": market,
            }
        )

    watchlist = build_watchlist(entries)
    payload = json.dumps(watchlist, ensure_ascii=False, indent=2) + "\n"
    existing = WATCHLIST.read_text(encoding="utf-8") if WATCHLIST.exists() else ""

    if payload == existing:
        print(f"watchlist unchanged ({len(entries)} cards)")
        return 0

    if args.dry_run:
        print(f"[dry-run] would update watchlist: {len(entries)} cards")
        for c in entries:
            print(f"  {c['cardKey']}  ({c['name']} {c['num']})")
        if missing:
            print(f"[dry-run] skipped unresolvable: {missing}")
        return 0

    # 先拉远端（action 可能刚提交过），再写、提交、推送
    subprocess.run(["git", "pull", "--rebase", "--autostash"], cwd=ROOT, check=True)
    WATCHLIST.write_text(payload, encoding="utf-8")
    subprocess.run(["git", "add", "cards/graded_watchlist.json"], cwd=ROOT, check=True)
    subprocess.run(
        ["git", "commit", "-m", f"chore: sync graded watchlist from devices ({len(entries)} cards)"],
        cwd=ROOT,
        check=True,
    )
    subprocess.run(["git", "push"], cwd=ROOT, check=True)
    print(f"watchlist synced and pushed: {len(entries)} cards")
    if missing:
        print(f"skipped unresolvable card keys: {missing}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
