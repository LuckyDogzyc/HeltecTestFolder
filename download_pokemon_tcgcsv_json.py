"""
download_pokemon_tcgcsv_json.py
--------------------------------

This script gathers Pokémon card data from the TCGCSV website using its
JSON endpoints. Unlike the large CSV/7z downloads, the JSON API
endpoints are publicly accessible without authentication and provide
detailed information about products and their pricing. The script will
enumerate all Pokémon groups (categoryId=3), then for each group fetch
the list of products and the current prices. It will merge these
structures and emit a single CSV file containing the following columns:

    productId, setName, productName, rarity, subTypeName,
    marketPrice, midPrice, lowPrice, highPrice

Where:

* **productId** – the TCGplayer product identifier.
* **setName** – the name of the card set (e.g. "SV06: Twilight Masquerade").
* **productName** – the product name as listed in TCGplayer.
* **rarity** – the card's rarity extracted from the product's
  extendedData. If missing, this will be blank.
* **subTypeName** – the price subtype ("Normal", "Holofoil", "Reverse Holofoil", etc.).
* **marketPrice, midPrice, lowPrice, highPrice** – the corresponding price
  values from the price entry. If a particular price is unavailable it
  will be left blank.

Usage example:

    python download_pokemon_tcgcsv_json.py --output pokemon_prices_full.csv

If you need to respect rate limits or network restrictions, you can
increase the delay between HTTP requests using the `--sleep` option.

Note: This script requires the `requests` library. Install it via
`pip install requests` if not already available.

References: The TCGCSV FAQ describes how to access category/group
endpoints for custom scraping【103792227977495†L11-L41】. Each group provides
products and price endpoints which this script uses to collect data.
"""

import argparse
import csv
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests


BASE_URL = "https://tcgcsv.com/tcgplayer"


def get_json(url: str, session: requests.Session, sleep: float = 0.0) -> Dict:
    """Fetch JSON from the given URL, optionally sleeping afterwards.

    Args:
        url: The full URL to query.
        session: A shared requests.Session to reuse connections.
        sleep: Seconds to sleep after a successful request.

    Returns:
        Parsed JSON dictionary.

    Raises:
        requests.RequestException if the request fails or JSON is invalid.
    """
    resp = session.get(url)
    resp.raise_for_status()
    data = resp.json()
    if sleep > 0:
        time.sleep(sleep)
    return data


def fetch_groups(category_id: int, session: requests.Session, sleep: float = 0.0) -> List[Dict]:
    """Retrieve all groups for a given category.

    Args:
        category_id: The category ID (3 for Pokémon).
        session: Shared requests session.
        sleep: Seconds to sleep between requests.

    Returns:
        List of group dictionaries.
    """
    url = f"{BASE_URL}/{category_id}/groups"
    data = get_json(url, session, sleep)
    return data.get("results", [])


def fetch_products_and_prices(category_id: int, group_id: int, session: requests.Session,
                              sleep: float = 0.0) -> Tuple[List[Dict], List[Dict]]:
    """Fetch products and prices for a specific group.

    Args:
        category_id: The category ID (3 for Pokémon).
        group_id: Group identifier.
        session: Shared requests session.
        sleep: Seconds to sleep between requests.

    Returns:
        Tuple containing the list of products and the list of price entries.
    """
    products_url = f"{BASE_URL}/{category_id}/{group_id}/products"
    prices_url = f"{BASE_URL}/{category_id}/{group_id}/prices"
    products = get_json(products_url, session, sleep).get("results", [])
    prices = get_json(prices_url, session, sleep).get("results", [])
    return products, prices


def extract_rarity(extended_data: List[Dict]) -> str:
    """Extract rarity from a product's extendedData.

    Args:
        extended_data: List of dictionaries from the product's extendedData field.

    Returns:
        The rarity value if present; otherwise an empty string.
    """
    for entry in extended_data:
        if entry.get("name") == "Rarity":
            return entry.get("value", "").strip()
    return ""


def merge_data(groups: List[Dict], category_id: int, session: requests.Session,
               sleep: float, writer: csv.writer) -> None:
    """Iterate over groups and write merged product-price rows to CSV.

    Args:
        groups: List of group dictionaries.
        category_id: Category ID (3 for Pokémon).
        session: Shared requests session.
        sleep: Seconds to sleep between requests.
        writer: CSV writer to output rows.
    """
    total_groups = len(groups)
    for idx, group in enumerate(groups, 1):
        group_id = group.get("groupId")
        set_name = group.get("name", "")
        if not group_id:
            continue

        # Fetch products and prices for this group
        try:
            products, prices = fetch_products_and_prices(category_id, group_id, session, sleep)
        except requests.RequestException as e:
            print(f"Failed to fetch data for group {group_id}: {e}", file=sys.stderr)
            continue

        # Build a lookup for price entries by (productId, subTypeName)
        price_lookup: Dict[Tuple[int, str], Dict] = {}
        for price in prices:
            pid = price.get("productId")
            subtype = price.get("subTypeName", "")
            if pid is not None and subtype is not None:
                price_lookup[(pid, subtype)] = price

        # Output a row for each product-price combination
        for product in products:
            pid = product.get("productId")
            name = product.get("name", "").strip()
            rarity = extract_rarity(product.get("extendedData", []))

            # Find any price entries matching this product
            # Prices may exist for multiple subtypes (Normal, Holofoil, etc.)
            found = False
            for (ppid, subtype), price_entry in price_lookup.items():
                if ppid == pid:
                    writer.writerow([
                        pid,
                        set_name,
                        name,
                        rarity,
                        subtype,
                        price_entry.get("marketPrice", ""),
                        price_entry.get("midPrice", ""),
                        price_entry.get("lowPrice", ""),
                        price_entry.get("highPrice", "")
                    ])
                    found = True
            if not found:
                # If no price entry for this product, write a row with blank prices
                writer.writerow([
                    pid,
                    set_name,
                    name,
                    rarity,
                    "",
                    "",
                    "",
                    "",
                    ""
                ])

        print(f"Processed group {idx}/{total_groups}: {set_name}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download Pokémon card data from TCGCSV JSON endpoints")
    parser.add_argument("--output", required=True, help="Output CSV file path")
    parser.add_argument("--sleep", type=float, default=0.1,
                        help="Seconds to sleep between requests (default: 0.1)")
    args = parser.parse_args()

    output_path = Path(args.output)

    session = requests.Session()
    # Do not inherit proxies from the environment; user can configure proxies via requests if needed
    session.trust_env = False

    try:
        groups = fetch_groups(3, session, args.sleep)
    except requests.RequestException as e:
        print(f"Failed to fetch group list: {e}", file=sys.stderr)
        sys.exit(1)

    with output_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "productId",
            "setName",
            "productName",
            "rarity",
            "subTypeName",
            "marketPrice",
            "midPrice",
            "lowPrice",
            "highPrice"
        ])
        merge_data(groups, 3, session, args.sleep, writer)

    print(f"Finished writing data to {output_path}")


if __name__ == "__main__":
    main()