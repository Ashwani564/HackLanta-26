"""
Build the GSU on-campus restaurant/dish dataset with Apify, then write a CSV and push it to S3.

Pipeline
  1. Google Maps Scraper (compass/crawler-google-places) -> address, place_id, lat/lng, price_level
  2. Uber Eats menu actor (one run per store URL)         -> dish_name, description, price_usd, category
  3. chains_nutrition.csv (from the chains' official PDFs/charts)
                                                          -> calories, macros, allergens  (allergen_source=chart)
  4. estimated_nutrition.csv (typical values for dishes with no official data; see its `basis` column)
                                                          -> calories, macros, allergens  (allergen_source=estimated)
  5. Text pass over dish name + description              -> allergens (menu_text if stated, else inferred), diet_tags
  6. Write gsu_dishes.csv, optionally upload to S3

Restaurants with no Uber Eats URL get their dishes straight from the two nutrition files.
Scrapes are cached in cache/; run with --refresh to scrape again (costs Apify credits).

Setup
  pip install -r requirements.txt
  Put these in a .env file next to this script (or export them):
  APIFY_TOKEN=...                 # Apify Console > Settings > Integrations
  S3_BUCKET=...                   # optional; also needs normal AWS credentials
  S3_KEY=data/gsu_dishes.csv      # optional

Fill in the Uber Eats store URLs below first (search ubereats.com with an address near GSU and copy the /store/ URL).
"""
import csv
import json
import math
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone

from apify_client import ApifyClient
from dotenv import load_dotenv

# reads .env next to this script; real environment variables still win
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# ---------------------------------------------------------------- config
GSU = (33.7531, -84.3853)  # approx. center of GSU downtown campus; used to pick the right branch of chains

MAPS_ACTOR = "compass/crawler-google-places"
# Any Uber Eats menu actor works; field names differ between them, so check the actor's Input tab
# and adjust ubereats_input() / iter_dishes() if you swap it. xtracto's bills per dataset record, so we ask for
# one record per store (menu nested) instead of one per dish.
UBER_ACTOR = "xtracto/ubereats-menu-scraper"

# restaurant_id, name, Google Maps query, Uber Eats store URL ("" = skip menu scrape for now)
RESTAURANTS = [
    ("mr-fries-man",    "Mr. Fries Man",               "Mr. Fries Man Atlanta",
     "https://www.ubereats.com/store/mr-fries-man-atlanta/zKpZEMOMSFaOId3B5ir5rQ"),
    ("saxbys",          "Saxby's",                     "Saxbys Georgia State University",        ""),
    ("moes",            "Moe's Southwestern Grill",    "Moe's Southwestern Grill Georgia State",
     "https://www.ubereats.com/store/moes-southwest-grill-171-auburn-avenue/V97MjW3aQY-lLlGPFwS27Q"),
    ("stir-house",      "Stir House Atlanta",          "Stir House Atlanta",
     "https://www.ubereats.com/store/stir-house-atlanta-broad-st-nw/BupUV7FBXJerRCyQUgggLw"),
    ("strikeout-wingz", "StrikeOut Wingz",             "StrikeOut Wingz Atlanta",
     "https://www.ubereats.com/store/strikeout-wingz-peachtree/FD3FXKHRWyW8JC7pl_sXZw"),
    ("india-eats",      "India Eats Restaurant",       "India Eats Restaurant Atlanta",
     "https://www.ubereats.com/store/india-eats-restaurant/Uk0HD03QTsepXs5jHeht4A"),
    ("mangos",          "Mangos Caribbean Restaurant", "Mangos Caribbean Restaurant Atlanta",
     "https://www.ubereats.com/store/mangos-caribbean-restaurant-downtown/B5XiYd5iTeegLaZMWuBjfA"),
    ("queen-tea",       "Queen Tea",                   "Queen Tea Atlanta",                      ""),
    ("starbucks",       "Starbucks",                   "Starbucks Georgia State University",     ""),
]

# Both nutrition files share these columns:
#   restaurant_id,dish_name,calories,protein_g,carbs_g,fat_g,sodium_mg,allergens,diet_tags,
#   match_category (only apply to this Uber Eats section), category/description/price_usd (used when the
#   restaurant has no Uber Eats menu), basis (where the numbers come from)
CHART_FILE = "chains_nutrition.csv"        # official figures published by the chain
ESTIMATE_FILE = "estimated_nutrition.csv"  # typical values, NOT published by the restaurant
CACHE_DIR = "cache"
OUT_FILE = "gsu_dishes.csv"

COLUMNS = [
    "restaurant_id", "restaurant_name", "place_id", "lat", "lng", "price_level",
    "dish_id", "dish_name", "description", "price_usd", "category",
    "calories", "protein_g", "carbs_g", "fat_g", "sodium_mg", "nutrition_source",
    "allergens", "allergen_source", "diet_tags", "scraped_at",
]

# ---------------------------------------------------------------- helpers
def slug(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()  # Caffè -> caffe
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())).strip()


def dist_km(a, b):
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def price_level(p):
    """Google Maps gives '$$' or a range like '$10–20'. Map to 1-4; blank if absent."""
    if not p:
        return ""
    if set(p.strip()) == {"$"}:
        return len(p.strip())
    nums = [int(n) for n in re.findall(r"\d+", p)]
    if not nums:
        return ""
    lo = nums[0]
    return 1 if lo < 10 else 2 if lo < 20 else 3 if lo < 30 else 4


def parse_price(v):
    if v is None or v == "":
        return ""
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    m = re.search(r"\d+(?:\.\d+)?", str(v).replace(",", ""))
    return round(float(m.group()), 2) if m else ""


def dish_price(it):
    """xtracto gives `price` in cents plus priceText/priceFormatted in dollars; other actors put dollars in `price`."""
    if "priceText" in it or "priceFormatted" in it:
        return parse_price(it.get("priceFormatted") or it.get("priceText"))
    return parse_price(it.get("price") or it.get("price_usd"))


def calories_from(item, text):
    """Only a single explicit number counts. Ranges ('250-560 Cal') stay blank -- never guessed."""
    for k in ("calories", "kcal", "cal"):
        if isinstance(item.get(k), (int, float)):
            return int(item[k])
    if re.search(r"\d+\s*[-–]\s*\d+\s*cal", text, re.I):
        return ""
    m = re.search(r"\b(\d{1,4})\s*(?:cal|kcal|calories)\b", text, re.I)
    return int(m.group(1)) if m else ""


# ---------------------------------------------------------------- allergens / diet tags
# Big 9 US allergens. Keyword hits are a LOWER BOUND: no hit != safe (fryer cross-contact, hidden sauces, etc.).
ALLERGEN_KEYWORDS = {
    "milk":      ["milk", "cheese", "cheddar", "mozzarella", "parmesan", "queso", "paneer", "butter", "cream",
                  "latte", "cappuccino", "yogurt", "ghee", "ranch", "alfredo", "whipped", "mocha", "boba milk"],
    "egg":       ["egg", "mayo", "mayonnaise", "aioli"],
    "fish":      ["fish", "salmon", "tuna", "cod", "tilapia", "snapper", "anchovy", "saltfish"],
    "shellfish": ["shrimp", "crab", "lobster", "crawfish", "prawn", "scallop"],
    "tree_nuts": ["almond", "cashew", "pecan", "walnut", "pistachio", "hazelnut", "macadamia"],
    "peanuts":   ["peanut"],
    "wheat":     ["bread", "bun", "flour", "wrap", "naan", "roti", "pasta", "noodle", "breaded", "battered",
                  "croissant", "bagel", "waffle", "pancake", "biscuit", "samosa", "dumpling", "patty", "cookie",
                  "muffin", "scone", "sandwich", "burrito", "quesadilla", "soy sauce", "teriyaki"],
    "soy":       ["soy", "tofu", "edamame", "teriyaki", "miso"],
    "sesame":    ["sesame", "tahini"],
}
STATED = re.compile(r"contains?:?\s*([a-z ,&/]+)", re.I)
DIET_PATTERNS = {   # only tagged when the menu text says it; halal is never inferred
    "vegan":       r"\bvegan\b",
    "vegetarian":  r"\bvegetarian\b|\bveggie\b|\(v\)",
    "gluten_free": r"gluten[- ]free|\(gf\)",
    "halal":       r"\bhalal\b",
}


def allergens_from_text(text):
    t = text.lower()
    stated = STATED.search(t)
    if stated:
        found = {a for a, kws in ALLERGEN_KEYWORDS.items() if any(k in stated.group(1) for k in kws + [a.replace("_", " ")])}
        if found:
            return sorted(found), "menu_text"
    t_milk = t.replace("peanut butter", "").replace("cocoa butter", "")
    found = set()
    for a, kws in ALLERGEN_KEYWORDS.items():
        hay = t_milk if a == "milk" else t
        if any(re.search(rf"\b{re.escape(k)}(?:e?s)?\b", hay) for k in kws):
            found.add(a)
    return sorted(found), "inferred"


def diet_tags_from_text(text):
    return [tag for tag, pat in DIET_PATTERNS.items() if re.search(pat, text, re.I)]


# ---------------------------------------------------------------- Apify steps
def scrape_places(client):
    run = client.actor(MAPS_ACTOR).call(run_input={
        "searchStringsArray": [q for _, _, q, _ in RESTAURANTS],
        # circle around campus; a text locationQuery geocoded to a single point and filtered every place out
        "customGeolocation": {"type": "Point", "coordinates": [GSU[1], GSU[0]], "radiusKm": 2},
        "maxCrawledPlacesPerSearch": 3,
        "language": "en",
        "maxImages": 0,
        "maxReviews": 0,
        "skipClosedPlaces": True,
    })
    items = list(client.dataset(run.default_dataset_id).iterate_items())
    places = {}
    for rid, name, query, _ in RESTAURANTS:
        first = norm(name).split()[0]
        cands = [i for i in items if i.get("searchString") == query] or \
                [i for i in items if first in norm(i.get("title"))]
        cands = [c for c in cands if (c.get("location") or {}).get("lat")]
        if not cands:
            print(f"[maps] no match for {name} -- fill place fields by hand")
            continue
        best = min(cands, key=lambda c: dist_km(GSU, (c["location"]["lat"], c["location"]["lng"])))
        d = dist_km(GSU, (best["location"]["lat"], best["location"]["lng"]))
        print(f"[maps] {name}: {best.get('title')} | {best.get('address')} | {d:.2f} km from GSU")
        places[rid] = {
            "place_id": best.get("placeId", ""),
            "lat": best["location"]["lat"],
            "lng": best["location"]["lng"],
            "price_level": price_level(best.get("price")),
            "address": best.get("address", ""),
        }
    return places


def ubereats_input(url):
    # Field name varies by actor (startUrls / storeUrls / urls). Check the actor's Input tab.
    return {"mode": "store", "stores": [url], "itemsAsRows": False}


def iter_dishes(rec):
    """Handles both nested (menu -> sections -> items) and flat (one row per item) actor outputs."""
    if rec.get("_error"):
        print(f"[menu] actor error: {rec.get('_error')} {rec.get('_errorDetail') or ''}")
    elif isinstance(rec.get("menuItems"), list):  # xtracto STORE_MENU: flat item list, section on each item
        # Uber repeats popular dishes under "Featured items"; keep only the copy in the real section
        real = {it.get("itemUuid") for it in rec["menuItems"] if it.get("categoryTitle") != "Featured items"}
        for it in rec["menuItems"]:
            if it.get("categoryTitle") == "Featured items" and it.get("itemUuid") in real:
                continue
            yield it.get("categoryTitle") or "", it
    elif rec.get("recordType") == "MENU_ITEM":    # xtracto with itemsAsRows=True
        yield rec.get("categoryTitle") or "", rec
    elif isinstance(rec.get("menu"), list):
        for sec in rec["menu"]:
            for it in sec.get("items", []) or []:
                yield sec.get("sectionName") or sec.get("title") or "", it
    elif rec.get("item_name") or rec.get("name"):
        yield rec.get("section") or rec.get("category") or "", rec


def scrape_menu(client, url):
    run = client.actor(UBER_ACTOR).call(run_input=ubereats_input(url))
    out = []
    for rec in client.dataset(run.default_dataset_id).iterate_items():
        for section, it in iter_dishes(rec):
            name = it.get("name") or it.get("item_name") or it.get("title")
            if name:
                out.append((section, it, name))
    return out


# ---------------------------------------------------------------- nutrition files
NUTRIENTS = ("calories", "protein_g", "carbs_g", "fat_g", "sodium_mg")


def load_chart(path):
    """-> {(restaurant_id, dish, match_category): row}; match_category "" applies to any section."""
    if not os.path.exists(path):
        return {}
    with open(path, newline="", encoding="utf-8") as f:
        return {(r["restaurant_id"], norm(r["dish_name"]), norm(r.get("match_category"))): r
                for r in csv.DictReader(f)}


def chart_lookup(chart, row):
    key = (row["restaurant_id"], norm(row["dish_name"]))
    return chart.get((*key, norm(row["category"]))) or chart.get((*key, ""))


def chart_dishes(rid, *charts):
    """Dishes for a restaurant with no Uber Eats menu come straight from the nutrition files."""
    seen = set()
    for chart in charts:
        for (r, dish, _), c in chart.items():
            if r == rid and dish not in seen:
                seen.add(dish)
                item = {"description": c.get("description", ""), "price": c.get("price_usd", "")}
                yield c.get("category", ""), item, c["dish_name"]


def add_nutrition(row, official, estimates):
    """Official chart wins over everything; estimates come next; otherwise only the menu text is used."""
    text = f"{row['dish_name']} {row['description']}"
    found, source = allergens_from_text(text)
    tags = set(diet_tags_from_text(text))
    row["nutrition_source"] = ""
    c, e = chart_lookup(official, row), chart_lookup(estimates, row)
    if c:
        for k in NUTRIENTS:
            row[k] = c.get(k, "") or row[k]
        row["nutrition_source"] = "official" if c.get("calories") else ""
        # allergen_source in the chart: blank = the chain's allergen statement, "ingredients" = read off its
        # ingredient list, "unknown" = the chain publishes neither, so keep what the menu text gives
        if c.get("allergen_source") != "unknown":
            found, source = (c.get("allergens") or "").split("|"), c.get("allergen_source") or "chart"
        tags |= set((c.get("diet_tags") or "").split("|"))
    elif e:
        for k in NUTRIENTS:
            row[k] = e.get(k, "") or row[k]
        row["nutrition_source"] = "estimated" if e.get("calories") else ""
        # keep anything the menu text names on top of the estimate; both are lower bounds
        found, source = set(found) | set((e.get("allergens") or "").split("|")), "estimated"
        tags |= set((e.get("diet_tags") or "").split("|"))
    row["allergens"] = "|".join(sorted(a for a in found if a))
    row["allergen_source"] = source
    row["diet_tags"] = "|".join(t for t in DIET_PATTERNS if t in tags)


# ---------------------------------------------------------------- main
def cached(name, fetch, refresh):
    """-> (data, scraped_at). Scrapes cost credits, so results are kept in cache/ until --refresh."""
    path = os.path.join(CACHE_DIR, f"{name}.json")
    if not refresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            saved = json.load(f)
        return saved["data"], saved["scraped_at"]
    saved = {"scraped_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "data": fetch()}
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(saved, f)
    return saved["data"], saved["scraped_at"]


def main():
    refresh = "--refresh" in sys.argv
    client = ApifyClient(os.environ.get("APIFY_TOKEN"))
    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    places, _ = cached("places", lambda: scrape_places(client), refresh)
    official, estimates = load_chart(CHART_FILE), load_chart(ESTIMATE_FILE)
    rows = []

    for rid, name, _, url in RESTAURANTS:
        place = places.get(rid, {})
        if url:
            menu, scraped_at = cached(f"menu_{rid}", lambda: scrape_menu(client, url), refresh)
        else:
            menu, scraped_at = list(chart_dishes(rid, official, estimates)), built_at
            if not menu:
                print(f"[menu] {name}: no Uber Eats URL and nothing in the nutrition files, skipping")
                continue
        seen = {}
        for section, it, dish in menu:
            desc = (it.get("description") or it.get("itemDescription") or "").strip()
            text = f"{dish} {desc}"
            base = f"{rid}__{slug(dish)}"
            seen[base] = seen.get(base, 0) + 1
            dish_id = base if seen[base] == 1 else f"{base}-{seen[base]}"

            row = {
                "restaurant_id": rid, "restaurant_name": name,
                "place_id": place.get("place_id", ""), "lat": place.get("lat", ""), "lng": place.get("lng", ""),
                "price_level": place.get("price_level", ""),
                "dish_id": dish_id, "dish_name": dish, "description": desc,
                "price_usd": dish_price(it),
                "category": section,
                "calories": calories_from(it, text),
                "protein_g": "", "carbs_g": "", "fat_g": "", "sodium_mg": "",
                "scraped_at": scraped_at,
            }
            add_nutrition(row, official, estimates)
            rows.append(row)
        print(f"[menu] {name}: {seen and sum(seen.values())} dishes")

    with open(OUT_FILE, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows -> {OUT_FILE}")

    bucket = os.environ.get("S3_BUCKET")
    if bucket:
        import boto3
        key = os.environ.get("S3_KEY", f"data/{OUT_FILE}")
        boto3.client("s3").upload_file(OUT_FILE, bucket, key)
        print(f"uploaded to s3://{bucket}/{key}")


if __name__ == "__main__":
    main()
