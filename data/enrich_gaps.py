"""
Fill the gaps in gsu_dishes.csv for Starbucks and Saxby's with SYNTHETIC values, and label them as such.

Why: neither chain publishes prices (Starbucks and Saxby's menu pages carry none; Starbucks prices vary by store),
and a few dozen drinks have no allergen line. Rather than leave those rows unusable, this fills ONLY what is blank:

  price_usd        blank -> typical price for the category/item, price_source = estimated
  allergens        blank -> rule-based inference from the dish text and typical recipe, allergen_source = inferred
                   ("none" in the cell means "inferred: no allergen"; the loader reads it as known-empty)
  diet_tags        any restaurant-stated tag is kept; vegan / vegetarian / halal are added by rule,
                   diet_source = inferred when we added anything

Nothing that came from a chart, an ingredient list or the menu text is ever overwritten. The inference only
errs toward MORE allergens and FEWER diet tags. It is not a substitute for the restaurant's own chart; replies
already tell people to confirm with the restaurant, and `inferred` rows are described as estimates.

Re-run after build_gsu_dataset.py (which regenerates the CSV without these columns):

    python3 data/enrich_gaps.py
"""
import csv
import os
import re
import sys

CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gsu_dishes.csv")
TARGETS = {"starbucks", "saxbys"}

# ---------------------------------------------------------------- prices (USD, typical medium/grande, Atlanta)
# (regex on "name category", price); first match wins. Specific items before general categories.
PRICES = {
    "starbucks": [
        (r"water|dasani|ethos|spindrift|poppi", 2.95),
        (r"evolution fresh|juice|sol-ti|supershot", 4.95),
        (r"koia|horizon|shake|protein beverage", 4.95),
        (r"protein box|bistro box|snack box", 9.95),
        (r"sandwich|wrap|pocket|panini|melt|grilled cheese|baguette|focaccia|sourdough", 7.45),
        (r"egg bites|bakes|oatmeal|overnight oats|yogurt|parfait", 5.25),
        (r"croissant|danish|muffin|scone|loaf|cake|brownie|cookie|pie|bakery|donut|doughnut|bagel|\btreat", 3.75),
        (r"chips|jerky|bar\b|bites|popcorn|beef stick|nuts|snack|spread", 2.95),
        (r"frappuccino", 6.25),
        (r"refresher|energy|dragon|pink drink|mango dream|cannon ball", 5.45),
        (r"matcha|chai|latte|cappuccino|macchiato|mocha|flat white|cortado|shaken espresso|aerocano|london fog", 5.75),
        (r"nitro|cold brew", 4.95),
        (r"americano|espresso", 4.25),
        (r"lemonade|hot chocolate|steamer", 4.25),
        (r"tea", 3.75),
        (r"coffee|roast", 3.45),
    ],
    "saxbys": [
        (r"smoothie", 6.95),
        (r"frolatte|matcha", 6.25),
        (r"energy drink", 5.25),
        (r"cold brew", 4.75),
        (r"latte|cappuccino|mocha|macchiato|chai|cortado|flat white", 5.25),
        (r"americano|espresso|red eye", 3.75),
        (r"tea", 3.50),
        (r"coffee|au lait", 3.25),
        (r"sandwich|panini|wrap|melt|club|bagel", 10.50),
        (r"breakfast", 8.50),
        (r"bakery|croissant|muffin|scone|cookie|brownie|loaf|cake", 3.75),
        (r"add-?on", 1.00),
        (r"seasonal|limited", 5.95),
        (r"drink", 4.75),
    ],
}

# ---------------------------------------------------------------- allergens
# Recipe-level knowledge. Matched against "name description category".
RULES = [
    ("milk",      r"latte|cappuccino|macchiato|mocha|frappuccino|flat white|cortado|chai|london fog|steamer|hot chocolate|"
                  r"\bcream\b|(?<!coconut)(?<!oat)(?<!almond)(?<!soy)milk|cheese|cheddar|gouda|feta|mozzarella|gruy[eè]re|yogurt|butter|custard|whipped|foam|caramel|"
                  r"brulee|cake|pie|muffin|scone|croissant|danish|brownie|bakes|egg bites|sandwich|wrap|pocket|frolatte|"
                  r"horchata|smoothie|matcha(?! tea)|bar\b|bites"),
    ("egg",       r"egg|croissant|brioche|muffin|cake|brownie|cookie|pie|scone|bakes|mayo|aioli|custard|sandwich|wrap|pocket"),
    ("wheat",     r"sandwich|wrap|pocket|bread|bagel|croissant|danish|muffin|scone|cake|brownie|cookie|pie|loaf|bakes|"
                  r"toast|biscuit|oat|granola|pretzel|bar\b|bites|cracker|chips ahoy|crisp"),
    ("soy",       r"soy|tofu|java chip|mocha|chocolate|sandwich|wrap|pocket|brownie|cookie|muffin|croissant|protein|bar\b|"
                  r"bites|impossible|teriyaki|bakes|cake"),
    ("tree_nuts", r"almond|cashew|pecan|walnut|pistachio|hazelnut|macadamia|praline|coconut|pink drink|dragon drink|"
                  r"mango dream|cannon ball|nutella|marzipan"),
    ("peanuts",   r"peanut|trail mix"),
    ("sesame",    r"sesame|bagel|everything|tahini|hummus|falafel"),
    ("fish",      r"salmon|tuna|anchov|fish"),
    ("shellfish", r"shrimp|crab|lobster"),
]
# Plain beverages with no dairy, bakery or flavouring ingredients that carry allergens.
PLAIN = re.compile(
    r"^(iced )?(hot |decaf |blonde |medium |dark |half-caff )?(coffee|americano|caff[eè] americano|espresso|red eye|"
    r"cold brew|nitro cold brew|aerocano|iced coffee|\w+ roast|.*pike place.*)\b|"
    r"\b(tea|tea lemonade|lemonade|refresher|energy refresher|energy drink|water|sparkling water|soda|juice)\b",
    re.I,
)
# Plain drinks that still carry an allergen: they win over PLAIN.
PLAIN_BUT = re.compile(r"cream|milk|latte|foam|caramel|chocolate|horchata|oatmilk|boston|coconut|dragon|pink|mango dream|cannon|"
                       r"smoothie|shake|yogurt", re.I)
# Bakery/food rows with no text to go on get the broad bakery set (superset on purpose).
FOOD_CATEGORY = re.compile(r"bakery|breakfast|lunch|snacks|treats|sandwich|trending", re.I)
FOOD_DEFAULT = ["egg", "milk", "soy", "wheat"]

# ---------------------------------------------------------------- diet
MEAT = re.compile(
    r"chicken|turkey|bacon|sausage|\bham\b|beef|pork|steak|pepperoni|prosciutto|salami|chorizo|jerky|beef stick|meat|"
    r"salmon|tuna|fish|shrimp|crab|lobster|anchov|pocket(?=.*(chicken|bacon))",
    re.I,
)
NOT_VEGETARIAN = re.compile(r"gelatin|lard|rennet|chomps|chicken|bacon|sausage|jerky", re.I)
ANIMAL_NON_MEAT = re.compile(r"\b(?:honey|whey|casein|gelatin|lard|cochineal|carmine|ghee|yogurt|cream|custard|caramel|"
                             r"(?<!coconut)(?<!oat)(?<!almond)(?<!soy)milk|latte|cappuccino|macchiato|mocha|frappuccino|steamer|foam|cheese|"
                             r"butter|egg|brulee)\b", re.I)
ALCOHOL = re.compile(r"\brum\b|bourbon|whisk|wine|beer|vodka|liqueur|amaretto|brandy|champagne|bailey|kahlua|"
                     r"hard seltzer|cocktail|spirit", re.I)


NEGATED = re.compile(r"(dairy|nut|gluten|egg|soy)[- ]free|non[- ]dairy|no dairy|dairy alternative", re.I)


def infer_allergens(text, category):
    text = NEGATED.sub("", text)
    found = {a for a, pat in RULES if re.search(rf"\b(?:{pat})(?:s|es)?\b", text, re.I)}
    plain = PLAIN.search(text.split("  ")[0]) and not PLAIN_BUT.search(text)
    if plain:
        return set()
    # Coffee/espresso/tea with no description is plain; anything food-like gets the broad set at minimum.
    if FOOD_CATEGORY.search(category) and not found:
        found = set(FOOD_DEFAULT)
    return found


def infer_diet(text, allergens, existing):
    tags = set(existing)
    meat = bool(MEAT.search(text)) or bool(NOT_VEGETARIAN.search(text))
    if not meat and "fish" not in allergens and "shellfish" not in allergens:
        tags.add("vegetarian")
        if "milk" not in allergens and "egg" not in allergens and not ANIMAL_NON_MEAT.search(text):
            tags.add("vegan")
        # Halal (inferred): nothing from an animal slaughter, no alcohol, no gelatin. Neither chain is certified.
        if not ALCOHOL.search(text) and not NOT_VEGETARIAN.search(text):
            tags.add("halal")
    # Tags the restaurant stated are never removed here, only added to.
    return tags


def estimate_price(rid, text):
    # name + category only: descriptions mention "water", "cream", "bar" in unrelated senses
    for pat, p in PRICES[rid]:
        if re.search(pat, text, re.I):
            return p
    return None


DIET_ORDER = ["vegan", "vegetarian", "halal", "gluten_free"]


def main():
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fields = list(reader.fieldnames)
        rows = list(reader)
    for extra in ("price_source", "diet_source"):
        if extra not in fields:
            fields.append(extra)

    stats = {"price": 0, "allergens": 0, "diet": 0, "no_price": []}
    for r in rows:
        r.setdefault("price_source", "")
        r.setdefault("diet_source", "")
        if r["restaurant_id"] not in TARGETS:
            if r["price_usd"]:
                r["price_source"] = r["price_source"] or "scraped"
            continue
        rid = r["restaurant_id"]
        text = f"{r['dish_name']} {r['description']}  {r['category']}"

        if not r["price_usd"]:
            p = estimate_price(rid, f"{r['dish_name']} {r['category']}")
            if p is None:
                stats["no_price"].append(r["dish_name"])
            else:
                r["price_usd"], r["price_source"] = f"{p:.2f}", "estimated"
                stats["price"] += 1

        # Only a BLANK allergen cell is filled. A stated list is never touched, but diet tags read it.
        if not r["allergens"]:
            found = infer_allergens(text, r["category"])
            # The restaurant's own "vegan" tag outranks our guess: never infer milk or egg onto a stated-vegan dish.
            if "vegan" in r["diet_tags"].split("|"):
                found -= {"milk", "egg"}
            r["allergens"] = "|".join(sorted(found)) if found else "none"
            r["allergen_source"] = "inferred"
            stats["allergens"] += 1
        allergens = {a for a in r["allergens"].split("|") if a and a != "none"}

        before = {t for t in r["diet_tags"].split("|") if t}
        after = infer_diet(text, allergens, before)
        if after != before:
            r["diet_tags"] = "|".join(t for t in DIET_ORDER if t in after)
            r["diet_source"] = "inferred"
            stats["diet"] += 1
        elif before:
            r["diet_source"] = "stated"

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"prices estimated: {stats['price']}  allergen cells inferred: {stats['allergens']}  diet rows changed: {stats['diet']}")
    if stats["no_price"]:
        print("no price rule matched:", stats["no_price"])
        sys.exit(1)


if __name__ == "__main__":
    main()
