"""
generate_product_id_buckets.py
--------------------------------

Create static productId bucket CSV files for ESP32 fast lookup.

GitHub raw is static hosting, not SQL. These bucket files provide a lightweight
index: the ESP32 computes productId % bucket_count, downloads only that small
CSV bucket, then scans a few rows instead of scanning the full multi-MB CSV.

Usage:

    python generate_product_id_buckets.py \
      --input cards/pokemon_cards.csv \
      --output-dir cards/product_id_buckets \
      --bucket-count 256
"""

from __future__ import annotations

import argparse
import csv
import shutil
from pathlib import Path
from typing import Dict, List

DEFAULT_BUCKET_COUNT = 256


def bucket_for_product_id(product_id: str, bucket_count: int) -> int:
    return int(product_id) % bucket_count


def generate_buckets(input_path: Path, output_dir: Path, bucket_count: int) -> Dict[str, int]:
    if bucket_count <= 0:
        raise ValueError("bucket_count must be positive")

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    with input_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError(f"missing CSV header in {input_path}")

        rows_by_bucket: List[List[dict[str, str]]] = [[] for _ in range(bucket_count)]
        total_rows = 0
        for row in reader:
            product_id = (row.get("productId") or "").strip()
            if not product_id.isdigit():
                continue
            rows_by_bucket[bucket_for_product_id(product_id, bucket_count)].append(row)
            total_rows += 1

    non_empty = 0
    max_rows = 0
    for bucket, rows in enumerate(rows_by_bucket):
        if not rows:
            continue
        non_empty += 1
        max_rows = max(max_rows, len(rows))
        rows.sort(key=lambda r: int(r["productId"]))
        bucket_path = output_dir / f"{bucket:03d}.csv"
        with bucket_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=reader.fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        (
            '{'
            f'"schemaVersion":1,'
            f'"bucketCount":{bucket_count},'
            f'"totalRows":{total_rows},'
            f'"nonEmptyBuckets":{non_empty},'
            f'"maxRowsPerBucket":{max_rows},'
            '"bucketRule":"productId % bucketCount",'
            '"fileName":"%03d.csv"'
            '}'
        ),
        encoding="utf-8",
    )

    return {
        "bucketCount": bucket_count,
        "totalRows": total_rows,
        "nonEmptyBuckets": non_empty,
        "maxRowsPerBucket": max_rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate static productId bucket CSV files")
    parser.add_argument("--input", required=True, help="Input full CSV path")
    parser.add_argument("--output-dir", required=True, help="Output directory for bucket CSV files")
    parser.add_argument("--bucket-count", type=int, default=DEFAULT_BUCKET_COUNT, help="Number of buckets; firmware must use the same value")
    args = parser.parse_args()

    stats = generate_buckets(
        input_path=Path(args.input),
        output_dir=Path(args.output_dir),
        bucket_count=args.bucket_count,
    )
    print(
        f"Wrote {stats['nonEmptyBuckets']} bucket files to {args.output_dir}: "
        f"bucketCount={stats['bucketCount']} totalRows={stats['totalRows']} "
        f"maxRowsPerBucket={stats['maxRowsPerBucket']}"
    )


if __name__ == "__main__":
    main()
