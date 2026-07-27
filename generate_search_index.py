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
    value = unicodedata.normalize("NFKC", value or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower()
    # Keep Unicode letters/numbers so Chinese and Japanese aliases are searchable.
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return re.sub(r"\s+", " ", value).strip()


def card_number(name: str) -> Optional[str]:
    # Examples: "Greninja ex - 132", "Charizard ex - 223/197".
    m = re.search(r"-\s*([A-Za-z0-9]+(?:/[A-Za-z0-9]+)?)\s*$", name or "")
    return m.group(1) if m else None


def load_aliases(path: Optional[Path]) -> Dict[str, List[str]]:
    if not path or not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {normalize(k): [str(v) for v in values] for k, values in raw.items()}


def aliases_for(name: str, aliases: Dict[str, List[str]]) -> List[str]:
    normalized_name = normalize(name.split(" - ")[0])
    hits: List[str] = []
    for canonical, values in aliases.items():
        if canonical and re.search(rf"\b{re.escape(canonical)}\b", normalized_name):
            hits.extend(values)
    return hits


def generate(input_path: Path, output_path: Path, limit: int = 0, aliases_path: Optional[Path] = None) -> Dict[str, Any]:
    aliases = load_aliases(aliases_path)
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
            num = text(row.get("cardNumber", "")) or card_number(name) or ""
            # Product IDs are internal identifiers; customer search should rely on
            # visible facts: name, set/series, rarity, variant, and card number.
            alias_terms = aliases_for(name, aliases)
            search = normalize(" ".join([name, set_name, rarity, subtype, num, *alias_terms]))
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
        "aliasesLoaded": sum(len(v) for v in aliases.values()),
        "searchFields": {"id": "internalProductId", "n": "name", "s": "setName", "r": "rarity", "t": "subTypeName", "num": "cardNumber", "m": "marketPrice", "l": "lowPrice", "q": "normalizedSearchText"},
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
    parser.add_argument("--aliases", help="Optional JSON map of canonical names to multilingual aliases")
    args = parser.parse_args()
    payload = generate(Path(args.input), Path(args.output), args.limit, Path(args.aliases) if args.aliases else None)
    print(f"Wrote {args.output}: {payload['cardsIncluded']} cards from {payload['totalRows']} rows")


if __name__ == "__main__":
    main()
