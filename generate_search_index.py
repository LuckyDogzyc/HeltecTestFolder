"""
generate_search_index.py
------------------------

Create a browser-side fuzzy-search index for the ESP32 WebUI.

The ESP32 should not fuzzy-search 40k+ cards. The device WebUI lets the user's
phone/browser fetch this compact JSON from GitHub raw, search locally, then send
only the selected productId back to ESP32.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def price(value: str) -> Optional[float]:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return round(float(value), 2)
    except ValueError:
        return None


def text(value: str) -> str:
    return (value or "").strip()


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def card_number(name: str) -> Optional[str]:
    # Examples: "Greninja ex - 132", "Charizard ex - 223/197".
    m = re.search(r"-\s*([A-Za-z0-9]+(?:/[A-Za-z0-9]+)?)\s*$", name or "")
    return m.group(1) if m else None


def generate(input_path: Path, output_path: Path, limit: int = 0) -> Dict[str, Any]:
    cards: List[Dict[str, Any]] = []
    total = 0
    with input_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            product_id = text(row.get("productId", ""))
            if not product_id.isdigit():
                continue
            name = text(row.get("productName", ""))
            set_name = text(row.get("setName", ""))
            rarity = text(row.get("rarity", ""))
            subtype = text(row.get("subTypeName", ""))
            num = card_number(name) or ""
            search = normalize(" ".join([product_id, name, set_name, rarity, subtype, num]))
            card = {
                "id": int(product_id),
                "n": name,
                "s": set_name,
                "r": rarity,
                "t": subtype,
                "num": num,
                "m": price(row.get("marketPrice", "")),
                "l": price(row.get("lowPrice", "")),
                "q": search,
            }
            cards.append(card)
            if limit and len(cards) >= limit:
                break

    payload: Dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "totalRows": total,
        "cardsIncluded": len(cards),
        "searchFields": {"id": "productId", "n": "name", "s": "setName", "r": "rarity", "t": "subTypeName", "num": "cardNumber", "m": "marketPrice", "l": "lowPrice", "q": "normalizedSearchText"},
        "cards": cards,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate compact browser-side Pokémon search index")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--limit", type=int, default=0, help="Optional max rows for tests; 0 = all")
    args = parser.parse_args()
    payload = generate(Path(args.input), Path(args.output), args.limit)
    print(f"Wrote {args.output}: {payload['cardsIncluded']} cards from {payload['totalRows']} rows")


if __name__ == "__main__":
    main()
