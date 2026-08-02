#!/usr/bin/env python3
"""Update all configured Pokémon card data sources.

The GitHub Action calls this script instead of hard-coding one TCGCSV
category. Add future markets to cards/sources.json and the daily job will
produce that source's CSV/search index plus a combined legacy feed for ESP32.
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "cards" / "sources.json"
ALIASES = ROOT / "cards" / "aliases.json"


def cli_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def run(args: list[str]) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(args, cwd=ROOT, check=True)


def load_config(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    sources = data.get("sources") or []
    if not isinstance(sources, list) or not sources:
        raise SystemExit(f"No sources configured in {path}")
    for idx, source in enumerate(sources):
        for key in ["market", "categoryId", "csv", "searchIndex"]:
            if key not in source:
                raise SystemExit(f"Source #{idx + 1} missing required key: {key}")
    return data


def combine_csvs(source_paths: list[Path], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    wrote_header = False
    total_rows = 0
    with output_path.open("w", newline="", encoding="utf-8") as out_f:
        writer: Any = None
        expected_header: list[str] | None = None
        for path in source_paths:
            with path.open("r", newline="", encoding="utf-8") as in_f:
                reader = csv.reader(in_f)
                try:
                    header = next(reader)
                except StopIteration:
                    continue
                if expected_header is None:
                    expected_header = header
                    writer = csv.writer(out_f)
                    writer.writerow(header)
                    wrote_header = True
                elif header != expected_header:
                    raise SystemExit(f"CSV header mismatch in {path}: {header} != {expected_header}")
                assert writer is not None
                for row in reader:
                    writer.writerow(row)
                    total_rows += 1
    if not wrote_header:
        raise SystemExit("No source CSV rows were available to combine")
    print(f"Wrote {output_path}: {total_rows} combined rows")


def main() -> None:
    parser = argparse.ArgumentParser(description="Update every configured TCGCSV Pokémon source")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="Source config JSON")
    parser.add_argument("--sleep", type=float, default=0.2, help="Delay between TCGCSV requests")
    parser.add_argument("--skip-download", action="store_true", help="Regenerate derived files from existing CSVs only")
    parser.add_argument("--limit", type=int, default=0, help="Optional search-index row limit for smoke tests")
    parser.add_argument("--dry-run", action="store_true", help="Print configured sources and exit")
    args = parser.parse_args()

    config = load_config(Path(args.config))
    sources = config["sources"]
    combined = config.get("combined") or {}

    if args.dry_run:
        print(json.dumps({"sources": sources, "combined": combined}, ensure_ascii=False, indent=2))
        return

    source_csvs: list[Path] = []
    for source in sources:
        market = source["market"]
        category_id = int(source["categoryId"])
        csv_path = ROOT / source["csv"]
        search_index_path = ROOT / source["searchIndex"]
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        source_csvs.append(csv_path)

        if not args.skip_download:
            run([
                sys.executable,
                "download_pokemon_tcgcsv_json.py",
                "--category-id",
                str(category_id),
                "--output",
                cli_path(csv_path),
                "--sleep",
                str(args.sleep),
            ])
        elif not csv_path.exists():
            raise SystemExit(f"Missing CSV for --skip-download: {csv_path}")

        cmd = [
            sys.executable,
            "generate_search_index.py",
            "--input",
            cli_path(csv_path),
            "--output",
            cli_path(search_index_path),
        ]
        if ALIASES.exists():
            cmd.extend(["--aliases", str(ALIASES.relative_to(ROOT))])
        if args.limit:
            cmd.extend(["--limit", str(args.limit)])
        run(cmd)
        print(f"Updated source {market}: category={category_id}")

    combined_csv = ROOT / combined.get("csv", "cards/pokemon_cards.csv")
    combine_csvs(source_csvs, combined_csv)

    epaper_json = ROOT / combined.get("epaperJson", "cards/epaper_cards.json")
    run([
        sys.executable,
        "generate_epaper_cards_json.py",
        "--input",
        cli_path(combined_csv),
        "--output",
        cli_path(epaper_json),
        "--limit",
        "50000",
        "--include-missing-price",
    ])

    bucket_dir = ROOT / combined.get("bucketDir", "cards/product_id_buckets")
    run([
        sys.executable,
        "generate_product_id_buckets.py",
        "--input",
        cli_path(combined_csv),
        "--output-dir",
        cli_path(bucket_dir),
        "--bucket-count",
        "256",
    ])

    combined_index = ROOT / combined.get("searchIndex", "cards/search_index.min.json")
    cmd = [
        sys.executable,
        "generate_search_index.py",
        "--input",
        cli_path(combined_csv),
        "--output",
        cli_path(combined_index),
    ]
    if ALIASES.exists():
        cmd.extend(["--aliases", str(ALIASES.relative_to(ROOT))])
    if args.limit:
        cmd.extend(["--limit", str(args.limit)])
    run(cmd)


if __name__ == "__main__":
    main()
