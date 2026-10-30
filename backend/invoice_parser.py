"""Universal, robust, layout-aware invoice parser for FinBotics.

Supports every kind of bill:
1. Spatial Grid B2B & Tax Invoices (with columns for HSN, UOM, MRP, Rate, Taxable, GST%, Amount).
2. Sequential tabular retail/supermarket bills (6-col, 5-col, 4-col, 3-col).
3. POS thermal multi-line bills (Item name on row 1, Qty x Rate Amount on row 2).
4. Simple 2-column bills (Cafes, Restaurants, Utility, Taxi, Services).
5. Indian GST compliance: Tax-Inclusive (MRP) vs Tax-Exclusive (B2B) auto-detection,
   CGST/SGST/IGST breakdown, GST Slabs (0%, 3%, 5%, 12%, 18%, 28%), Rate > MRP detection.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any


MONEY = r"(?:Rs\.?|INR|[₹€$])?\s*([0-9][0-9,]*(?:\.\d{1,2})?)"
TOTAL_LABEL = r"(?:grand\s*total|net\s*(?:amount|payable)|amount\s*payable|invoice\s*total|total\s*payable|total\s*amount\s*after\s*tax|bill\s*amount|total\s*due|final\s*total|total\s*in\s*inr)"
SUBTOTAL_LABEL = r"(?:sub\s*total|taxable\s*(?:total|value|amount)|subtotal)"
TAX_LABEL = r"(?:total\s*(?:gst|tax)|gst\s*total|cgst\s*\+\s*sgst|tax\s*amount|total\s*tax\s*amount)"

COLUMN_KEYWORDS = {
    "sno": [r"^(?:s\.?l\.?|s\.?i\.?|sr|sno|sl\s*no|si\s*no|item\s*no)\.?$", r"^si$", r"^sl$"],
    "name": [
        r"^(?:item\s*name|item|d[es]{1,2}[ct]rip(?:tion)?(?:\s*of\s*goods)?|particulars?|product|goods|items?)$",
        r"^.*(?:description|destription|particulars).*$"
    ],
    "qty": [r"^(?:qty|quantity|qnty|quant|nos?)$"],
    "uom": [r"^(?:uom|unit|measure|pkg|per)$", r"^per\b.*$"],
    "hsn": [r"^(?:hsn|sac|hsn\s*/\s*sac|hsn\s*code|sac\s*code)$"],
    "mrp": [r"^(?:mrp|m\.r\.p\.?)$"],
    "rate": [r"^(?:rate|price|unit\s*rate|unit\s*price|unit\s*cost)$"],
    "gst_pct": [r"^(?:gst\s*%|tax\s*%|gst|tax\s*rate|gst\s*rate|vat\s*%)$"],
    "taxable": [r"^(?:taxable|taxable\s*value|taxable\s*amt|taxable\s*amount|assessable\s*value)$"],
    "gst_amt": [r"^(?:gst\s*amt|tax\s*amt|tax\s*amount|cgst|sgst|igst|total\s*tax)$"],
    "amount": [r"^(?:amount|total|line\s*total|net\s*amt|net\s*amount|item\s*total)$"]
}

SUMMARY_ROW_RE = re.compile(
    r"\b(sub\s*total|taxable\s*total|taxable\s*amt|taxable\s*value|grand\s*total|invoice\s*total|"
    r"total\s*payable|amount\s*chargeable|net\s*payable|total\b|"
    r"round\s*off|amount\s*in\s*words|thank\s*you|"
    r"terms\s*&|authorized\s*signatory|e\.\s*&\s*o\.e\.|bank\s*details|upi\s*id|mode\s*of\s*payment)\b",
    re.I
)

KNOWN_CHAINS = [
    ("bigbasket", "BigBasket"),
    ("d-mart", "D-Mart"),
    ("dmart", "D-Mart"),
    ("avenue supermarts", "D-Mart"),
    ("blinkit", "Blinkit"),
    ("grofers", "Blinkit"),
    ("zepto", "Zepto"),
    ("reliance smart", "Reliance Smart"),
    ("reliance retail", "Reliance Smart"),
    ("jiomart", "JioMart"),
    ("swiggy instamart", "Swiggy Instamart"),
    ("swiggy", "Swiggy"),
    ("zomato", "Zomato"),
    ("more supermarket", "More Supermarket"),
    ("more retail", "More Supermarket"),
    ("star bazaar", "Star Bazaar"),
    ("spencer", "Spencer's"),
    ("nature's basket", "Nature's Basket"),
    ("apollo pharmacy", "Apollo Pharmacy"),
    ("medplus", "MedPlus"),
    ("amazon", "Amazon"),
    ("flipkart", "Flipkart"),
    ("croma", "Croma"),
    ("vijay sales", "Vijay Sales"),
    ("uber", "Uber"),
    ("ola", "Ola"),
    ("mcdonald", "McDonald's"),
    ("subway", "Subway"),
    ("starbucks", "Starbucks"),
    ("domino", "Domino's Pizza"),
    ("kfc", "KFC"),
    ("pizza hut", "Pizza Hut"),
    ("haldiram", "Haldiram's"),
]

GSTIN_RE = re.compile(r"\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b", re.I)
FUZZY_GSTIN_RE = re.compile(r"\b([0-9OIL]{2}[A-Z]{5}[0-9OIL]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b", re.I)


def _clean_money(val: Any) -> float | None:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().replace(",", "").replace("₹", "").replace("Rs.", "").replace("Rs", "")
    s = s.rstrip("%")
    try:
        f = float(s)
        return f if 0 <= f <= 50_000_000 else None
    except ValueError:
        return None


def _clean_gstin(raw: str, full_context: str = "") -> str:
    g = raw.strip().upper()
    if len(g) != 15:
        return ""
    chars = list(g)
    # Positions 0,1 for state code
    if chars[0] in ("O", "D"):
        chars[0] = "0"
    elif chars[0] in ("I", "L"):
        chars[0] = "1"
    elif chars[0] == "Z":
        chars[0] = "2"
        
    if chars[1] in ("O", "D"):
        chars[1] = "0"
    elif chars[1] in ("I", "L"):
        chars[1] = "1"
    elif chars[1] == "B":
        if chars[0] == "2" and any(k in full_context.upper() for k in ("KARNATAKA", "KAMATAKA", "29")):
            chars[1] = "9"
        else:
            chars[1] = "8"
    elif chars[1] == "S":
        chars[1] = "5"

    # Positions 7,8,9,10 must be digits for PAN
    for idx in (7, 8, 9, 10):
        if chars[idx] in ("O", "D"):
            chars[idx] = "0"
        elif chars[idx] in ("I", "L"):
            chars[idx] = "1"
        elif chars[idx] == "S":
            chars[idx] = "5"
        elif chars[idx] == "B":
            chars[idx] = "8"

    cleaned = "".join(chars)
    if GSTIN_RE.fullmatch(cleaned):
        return cleaned
    if re.fullmatch(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}", cleaned):
        return cleaned

    # Fallback: normalize char 13 to Z
    chars[13] = "Z"
    cleaned = "".join(chars)
    if re.fullmatch(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}", cleaned):
        return cleaned
    return ""


def _extract_gstin(text: str) -> str:
    # 1. Isolate Seller Section (everything before Buyer/Consignee)
    seller_lines = []
    for line in text.splitlines():
        if re.search(r"\b(consignee|buyer|ship\s*to|bill\s*to|billed\s*to)\b", line, re.I):
            break
        seller_lines.append(line)
    seller_text = "\n".join(seller_lines)

    # Search seller section first
    for target in (seller_text, text):
        if not target.strip():
            continue
        # Check explicit label
        m = re.search(r"GSTIN(?:/UIN)?[:\s#-]*([0-9A-Za-z]{15})", target, re.I)
        if m:
            c = _clean_gstin(m.group(1), text)
            if c:
                return c
        for m in GSTIN_RE.finditer(target):
            c = _clean_gstin(m.group(1), text)
            if c:
                return c
        for m in FUZZY_GSTIN_RE.finditer(target):
            c = _clean_gstin(m.group(1), text)
            if c:
                return c
        for line in target.splitlines():
            spaceless = line.replace(" ", "").upper()
            if "GSTIN" in spaceless:
                after = spaceless.split("GSTIN")[-1].lstrip(":/UIN-#")
                if len(after) >= 15:
                    c = _clean_gstin(after[:15], text)
                    if c:
                        return c
    return ""


def _extract_invoice_number(text: str, grid_rows: list[dict[str, Any]] | None = None) -> str:
    # 1. Spatial search: check token right below "Invoice No"
    if grid_rows:
        for idx, r in enumerate(grid_rows[:-1]):
            for t in r["tokens"]:
                if re.match(r"^invoice\s*no\.?$", t["text"], re.I):
                    next_row = grid_rows[idx + 1]
                    for nt in next_row["tokens"]:
                        if abs(nt["x"] - t["x"]) < 50 and not re.search(r"\b(date|dated|delivery|terms)\b", nt["text"], re.I):
                            val = nt["text"].strip().upper()
                            if len(val) >= 2 and not re.match(r"^(?:DATE|DATED|TIME|GSTIN|TOTAL|AMOUNT)$", val):
                                return val

    # 2. Check slash-formatted invoice numbers (e.g. SHB/456/20 or INV/2021/001)
    slash_m = re.search(r"\b([A-Za-z0-9]{1,8}/\d{1,6}/\d{2,4})\b", text)
    if slash_m:
        val = slash_m.group(1).upper()
        if not re.search(r"\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b", val):
            return val

    # 3. Standard regex patterns
    patterns = [
        r"(?:invoice|bill|receipt|order|cash\s*memo|tax\s*invoice)\s*(?:no\.?|number|#|id)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{1,30})",
        r"(?:inv|bill)\s*(?:#|no\.?)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{1,30})",
        r"\b(?:inv|bill|doc)\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9/_-]{2,30})",
        r"\b([A-Z]{2,4}-\d{4}-\d{3,6})\b",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.I)
        if m:
            val = m.group(1).strip().upper()
            if not re.match(r"^(?:DATE|DATED|TIME|GSTIN|TOTAL|AMOUNT|RS|INR|DELIVERY|MODE|TERMS|ORDER|BUYER|CONSIGNEE)$", val):
                return val
    return ""


def _extract_invoice_date(text: str, grid_rows: list[dict[str, Any]] | None = None) -> str:
    # 1. Spatial search: check token right below "Dated"
    if grid_rows:
        for idx, r in enumerate(grid_rows[:-1]):
            for t in r["tokens"]:
                if re.match(r"^dated?$", t["text"], re.I):
                    next_row = grid_rows[idx + 1]
                    for nt in next_row["tokens"]:
                        if abs(nt["x"] - t["x"]) < 50:
                            dm = re.search(r"\b(\d{1,2}-[A-Za-z]{3}-\d{2,4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b", nt["text"])
                            if dm:
                                return dm.group(1).strip()

    # 2. Check for explicit "Dated: <Date>"
    dated_m = re.search(r"\bdated?\s*[:=-]?\s*(\d{1,2}-[A-Za-z]{3}-\d{2,4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", text, re.I)
    if dated_m:
        return dated_m.group(1).strip()

    # 3. Common date patterns, avoiding Ack Date
    for line in text.splitlines():
        if re.search(r"\back\s*date\b", line, re.I):
            continue
        patterns = [
            r"\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b",
            r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b",
            r"\b(\d{4}[/-]\d{1,2}[/-]\d{1,2})\b",
            r"\b(\d{1,2}-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{2,4})\b",
            r"\b(\d{1,2}\.\d{1,2}\.\d{2,4})\b",
        ]
        for pat in patterns:
            m = re.search(pat, line, re.I)
            if m:
                return m.group(1).strip()
                
    return datetime.now().strftime("%d %b %Y")


def _extract_vendor(rows: list[str], full_text: str, grid_rows: list[dict[str, Any]] | None = None) -> str:
    tl = full_text.lower()
    for trigger, brand in KNOWN_CHAINS:
        if re.search(r"\b" + re.escape(trigger) + r"\b", tl):
            return brand

    # Check bottom signatory: "for <Vendor Name>"
    sig_m = re.search(r"\bfor\s+([A-Za-z0-9 &.,'-]{3,60})\b", full_text, re.I)
    signatory_store = None
    if sig_m:
        candidate = sig_m.group(1).strip()
        if not re.search(r"\b(authorised|signatory|customer|buyer|payment)\b", candidate, re.I):
            signatory_store = candidate

    # Look through header rows
    source_rows = [r["text"] for r in (grid_rows or [])] if grid_rows else rows
    for line in source_rows[:15]:
        raw_line = line.strip()
        # 1. Skip metadata banners and IRN/Ack directly
        if re.search(r"^(?:tax\s*invoice|retail\s*invoice|e-invoice|irn\b|ack\b|ack\s*no|ack\s*date|qr\s*code|original|duplicate|consignee|buyer)", raw_line, re.I):
            continue
        if re.search(r"\b(consignee|buyer|ship\s*to|bill\s*to|billed\s*to)\b", raw_line, re.I):
            break

        clean = raw_line
        # Split 2-column headers if present (e.g. "Store Name Invoice No Dated")
        if re.search(r"\b(invoice\s*no|bill\s*no)\b", clean, re.I):
            clean = re.split(r"\b(invoice\s*no|bill\s*no)\b", clean, flags=re.I)[0].strip()
        elif re.search(r"\bdated?\b", clean, re.I):
            clean = re.split(r"\bdated?\b", clean, flags=re.I)[0].strip()

        # Remove banners
        clean = re.sub(r"\s*[-–—]\s*(?:tax\s*invoice|retail\s*invoice|cash\s*memo|bill\s*of\s*supply|invoice)\b.*$", "", clean, flags=re.I)
        clean = re.sub(r"^(?:welcome\s*to\s+|tax\s*invoice\s*[-–:]?\s*|e-invoice\s*[-–:]?\s*)", "", clean, flags=re.I)
        clean = clean.strip(" -:#|*")
        
        # Skip metadata, hashes, or address fragments
        if re.search(r"\b(tax\s*invoice|e-invoice|irn|ack\s*no|ack\s*date|qr\s*code|original|duplicate)\b", clean, re.I):
            continue
        if re.search(r"\b(gstin|state\s*name|code\s*:|hsn|pan|fssai|phone|email)\b", clean, re.I):
            continue
        # Skip hashes without spaces
        if " " not in clean and len(clean) >= 10:
            continue
        if len(clean) >= 3 and not re.search(r"^\d+$", clean) and re.search(r"[A-Za-z]", clean):
            return clean[:60]
            
    if signatory_store:
        return signatory_store

    return "Store / Vendor"


def _cluster_ocr_tokens(lines: list[dict[str, Any]] | None, raw_text: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Convert raw OCR lines/boxes into geometrically clustered visual rows."""
    tokens = []
    for line in lines or []:
        text = str(line.get("text", "")).strip()
        box = line.get("box")
        if not text:
            continue
        if not isinstance(box, list) or len(box) < 2:
            continue
        try:
            xs = [float(p[0]) for p in box if isinstance(p, (list, tuple)) and len(p) >= 2]
            ys = [float(p[1]) for p in box if isinstance(p, (list, tuple)) and len(p) >= 2]
            if len(xs) < 2 or len(ys) < 2:
                continue
            tokens.append({
                "text": text,
                "xmin": min(xs),
                "xmax": max(xs),
                "ymin": min(ys),
                "ymax": max(ys),
                "x": (min(xs) + max(xs)) / 2.0,
                "y": (min(ys) + max(ys)) / 2.0,
                "height": max(ys) - min(ys),
                "width": max(xs) - min(xs),
                "confidence": float(line.get("confidence", 0.0) or 0.0)
            })
        except (TypeError, ValueError, IndexError):
            continue

    if not tokens:
        raw_rows = [r.strip() for r in raw_text.splitlines() if r.strip()]
        return [], raw_rows

    import numpy as np
    median_h = float(np.median([t["height"] for t in tokens])) if tokens else 20.0
    y_tol = max(10.0, median_h * 0.70)

    tokens.sort(key=lambda t: t["y"])
    rows: list[dict[str, Any]] = []
    for t in tokens:
        assigned = False
        for r in rows:
            if abs(t["y"] - r["y"]) < y_tol:
                r["tokens"].append(t)
                r["y"] = (r["y"] * (len(r["tokens"]) - 1) + t["y"]) / len(r["tokens"])
                assigned = True
                break
        if not assigned:
            rows.append({"y": t["y"], "tokens": [t]})

    text_rows = []
    for r in rows:
        r["tokens"].sort(key=lambda t: t["xmin"])
        r["text"] = " ".join(t["text"] for t in r["tokens"])
        text_rows.append(r["text"])

    return rows, text_rows


def _match_column_type(text: str) -> str | None:
    clean = text.strip().lower()
    for col_type, patterns in COLUMN_KEYWORDS.items():
        for pat in patterns:
            if re.match(pat, clean):
                return col_type
    return None


def _parse_spatial_grid(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, float]]:
    """Engine 1: Spatial Grid Table Parser using detected table columns."""
    if not rows:
        return [], [], {}

    # Locate table header
    header_idx = None
    columns = []
    for idx, r in enumerate(rows):
        matched = []
        for t in r["tokens"]:
            col_type = _match_column_type(t["text"])
            if col_type:
                matched.append((col_type, t))
        types_found = {m[0] for m in matched}
        if len(types_found) >= 3 and ("amount" in types_found or "rate" in types_found or "taxable" in types_found):
            header_idx = idx
            columns = matched
            break

    if header_idx is None or not columns:
        return [], [], {}

    items = []
    flags = []
    totals = {}
    tax_sub_rows = []

    first_num_col_x = min([c[1]["xmin"] for c in columns if c[0] in ("hsn", "qty", "rate", "taxable", "amount", "mrp")])
    sno_col = [c for c in columns if c[0] == "sno"]
    sno_max_x = sno_col[0][1]["xmax"] if sno_col else 0

    for r in rows[header_idx + 1:]:
        text = r["text"].strip()
        
        # 1. Summary row detection: extract totals and BREAK immediately
        if SUMMARY_ROW_RE.search(text):
            for label, key in [(TOTAL_LABEL, "grandTotal"), (SUBTOTAL_LABEL, "subtotal"), (TAX_LABEL, "totalTax")]:
                m = re.search(rf"{label}\s*[:=-]?\s*{MONEY}", text, re.I)
                if m:
                    val = _clean_money(m.group(1))
                    if val is not None:
                        totals[key] = val
            # Fallback: if line has Total, capture last monetary value
            if "grandTotal" not in totals and re.search(r"\b(?:grand\s*total|invoice\s*total|total)\b", text, re.I):
                amounts = re.findall(r"([0-9][0-9,]*(?:\.\d{1,2})?)", text)
                for a in reversed(amounts):
                    val = _clean_money(a)
                    if val and val > 0:
                        totals["grandTotal"] = val
                        break
            break

        # 2. In-table tax sub-rows (CGST / SGST / IGST)
        if re.search(r"\b(CGST|COST|SGST|IGST|UTGST|Output\s*CGST|Output\s*SGST|Input\s*CGST|Input\s*SGST)\b", text, re.I):
            m = re.search(r"\b(CGST|COST|SGST|IGST|UTGST)\b.*?([0-9][0-9,]*(?:\.\d{1,2})?)", text, re.I)
            if m:
                tax_type = m.group(1).upper()
                if tax_type == "COST":
                    tax_type = "CGST"
                tax_amt = _clean_money(m.group(2))
                if tax_amt is not None:
                    tax_sub_rows.append((tax_type, tax_amt))
            continue

        # 3. Skip header fragments without numbers (e.g. single 'to' or 'No.')
        if not re.search(r"\d", text):
            continue

        row_item: dict[str, Any] = {
            "name": "", "qty": None, "uom": None, "hsn": None,
            "mrp": None, "rate": None, "gst": None, "taxable": None, "amount": None
        }

        name_tokens = []
        for t in r["tokens"]:
            # Skip serial numbers in sno column
            if sno_max_x > 0 and t["xmax"] <= sno_max_x + 10 and re.match(r"^\d+$", t["text"]):
                continue

            # If token is to the left of all numeric columns or is non-numeric text:
            if t["xmax"] <= first_num_col_x and not re.match(r"^[\d.,%]+$", t["text"]):
                name_tokens.append(t["text"])
                continue

            # Assign to closest column
            best_col = None
            best_dist = 999999
            for col_type, col_t in columns:
                if col_type in ("sno", "name"):
                    continue
                dist = abs(t["x"] - col_t["x"])
                if dist < best_dist:
                    best_dist = dist
                    best_col = col_type

            val_str = t["text"].replace(",", "").rstrip("%")
            try:
                num_val = float(val_str)
            except ValueError:
                num_val = None

            if best_col == "qty":
                qm = re.match(r"^(\d+(?:\.\d+)?)\s*([A-Za-z]*)", t["text"])
                if qm:
                    row_item["qty"] = float(qm.group(1))
                    if qm.group(2):
                        row_item["uom"] = qm.group(2)
                elif num_val is not None:
                    row_item["qty"] = num_val
            elif best_col == "uom":
                row_item["uom"] = t["text"]
            elif best_col == "hsn":
                row_item["hsn"] = t["text"]
            elif best_col == "mrp" and num_val is not None:
                row_item["mrp"] = num_val
            elif best_col == "rate" and num_val is not None:
                row_item["rate"] = num_val
            elif best_col == "gst_pct":
                if "%" in t["text"] or num_val in (0, 3, 5, 12, 18, 28):
                    row_item["gst"] = int(num_val) if num_val is not None else None
            elif best_col == "taxable" and num_val is not None:
                row_item["taxable"] = num_val
            elif best_col == "amount" and num_val is not None:
                row_item["amount"] = num_val

        item_name = " ".join(name_tokens).strip()
        item_name = re.sub(r"^\d+\s*[\.\)]\s*", "", item_name)
        if item_name and len(item_name) >= 2 and re.search(r"[A-Za-z]", item_name):
            row_item["name"] = item_name

            # Mathematical decimal-drop correction (e.g. 50000 instead of 500.00 when amount is 3500.00 and qty is 7)
            if row_item["rate"] is not None and row_item["amount"] is not None and row_item["qty"] is not None and row_item["qty"] > 0:
                expected_rate = round(row_item["amount"] / row_item["qty"], 2)
                if expected_rate > 0:
                    ratio = row_item["rate"] / expected_rate
                    if abs(ratio - 100.0) < 0.5 or abs(ratio - 10.0) < 0.1 or abs(ratio - 1000.0) < 1.0:
                        row_item["rate"] = expected_rate

            # Rate vs MRP validation check (Test 7 requirement)
            if row_item["rate"] is not None and row_item["mrp"] is not None:
                if row_item["rate"] > row_item["mrp"]:
                    flags.append({
                        "type": "warn",
                        "code": "rate_above_mrp",
                        "msg": f"Rate (₹{row_item['rate']:.2f}) exceeds MRP (₹{row_item['mrp']:.2f}) for {row_item['name']}."
                    })

            items.append(row_item)

    # Link in-table tax sub-rows back to items
    if tax_sub_rows and items:
        tot_cgst = sum(amt for ttype, amt in tax_sub_rows if ttype == "CGST" and amt)
        tot_sgst = sum(amt for ttype, amt in tax_sub_rows if ttype == "SGST" and amt)
        tot_igst = sum(amt for ttype, amt in tax_sub_rows if ttype == "IGST" and amt)
        tot_tax = tot_cgst + tot_sgst + tot_igst
        if tot_tax > 0:
            totals["totalTax"] = tot_tax
        
        for it in items:
            if it.get("gst") is None and it.get("amount"):
                taxable = it.get("taxable") or it["amount"]
                it["taxable"] = taxable
                it["gst"] = round((tot_tax / taxable) * 100) if taxable > 0 else 0
                it["cgst"] = tot_cgst
                it["sgst"] = tot_sgst
                it["igst"] = tot_igst
                it["amount"] = round(taxable + tot_tax, 2)

    return items, flags, totals


def _parse_sequential_line(line: str) -> dict[str, Any] | None:
    """Engine 2: Multi-number tabular line matching (BigBasket, D-Mart, Zepto, Blinkit)."""
    if re.search(r"\b(?:total|subtotal|gstin|invoice|bill\s*no|date|thank\s*you|customer|payment)\b", line, re.I):
        return None

    # Try 6-column: Name Qty MRP Rate GST% Amount
    m6 = re.match(r"^(.{2,60}?)\s+(\d{1,4}(?:\.\d{1,3})?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)\s+(\d{1,2})%\s+([\d,]+(?:\.\d{1,2})?)$", line.strip())
    if m6:
        name, q, mrp, rate, gst, amt = m6.groups()
        return {
            "name": name.strip(), "qty": float(q), "mrp": _clean_money(mrp),
            "rate": _clean_money(rate), "gst": int(gst), "amount": _clean_money(amt)
        }

    # Try 5-column: Name Qty MRP Rate Amount
    m5 = re.match(r"^(.{2,60}?)\s+(\d{1,4}(?:\.\d{1,3})?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)$", line.strip())
    if m5:
        name, q, mrp, rate, amt = m5.groups()
        return {
            "name": name.strip(), "qty": float(q), "mrp": _clean_money(mrp),
            "rate": _clean_money(rate), "gst": None, "amount": _clean_money(amt)
        }

    # Try 4-column: Name Qty Rate Amount
    m4 = re.match(r"^(.{2,60}?)\s+(\d{1,4}(?:\.\d{1,3})?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)$", line.strip())
    if m4:
        name, q, rate, amt = m4.groups()
        return {
            "name": name.strip(), "qty": float(q), "mrp": _clean_money(rate),
            "rate": _clean_money(rate), "gst": None, "amount": _clean_money(amt)
        }

    # Try 2-column: Name Amount (simple bills)
    m2 = re.match(r"^([A-Za-z0-9 &.,'()/-]{3,50})\s{2,}(?:Rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)$", line.strip())
    if m2:
        name, amt = m2.groups()
        amount_val = _clean_money(amt)
        if amount_val and amount_val > 0 and not re.search(r"\b(?:tax|total|subtotal|balance|due)\b", name, re.I):
            return {
                "name": name.strip(), "qty": 1.0, "mrp": amount_val,
                "rate": amount_val, "gst": None, "amount": amount_val
            }

    return None


def _parse_thermal_items(rows: list[str]) -> list[dict[str, Any]]:
    """Engine 3: Two-line POS receipt parser."""
    items = []
    i = 0
    while i < len(rows) - 1:
        line1 = rows[i].strip()
        line2 = rows[i + 1].strip()
        
        # Check if line2 matches "1 PC x 120.00   120.00" or similar
        m = re.match(r"^(\d+(?:\.\d+)?)\s*(?:pcs?|nos?|kg|gm|l|ltr|pkts?|x|@)?\s*[xX@]?\s*([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)$", line2)
        if m and len(line1) >= 2 and re.search(r"[A-Za-z]", line1) and not re.search(r"\b(?:total|bill|subtotal|gstin)\b", line1, re.I):
            q, rate, amt = m.groups()
            items.append({
                "name": re.sub(r"^\d+\s*[\.\)]\s*", "", line1).strip(),
                "qty": float(q),
                "mrp": _clean_money(rate),
                "rate": _clean_money(rate),
                "gst": None,
                "amount": _clean_money(amt)
            })
            i += 2
            continue
        i += 1
    return items


def parse_invoice(text: str, lines: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Universal invoice extraction pipeline.
    
    Tries spatial grid extraction first; falls back to sequential and POS parsers.
    """
    grid_rows, text_rows = _cluster_ocr_tokens(lines, text)
    full_text = "\n".join(text_rows) if text_rows else text

    # Extract metadata
    vendor = _extract_vendor(text_rows, full_text, grid_rows)
    bill_no = _extract_invoice_number(full_text, grid_rows)
    date_val = _extract_invoice_date(full_text, grid_rows)
    gstin_val = _extract_gstin(full_text)

    # 1. Try Spatial Grid Parser
    items, flags, grid_totals = _parse_spatial_grid(grid_rows)

    # 2. If no spatial grid items, try sequential line parser
    if not items:
        for row in text_rows:
            item = _parse_sequential_line(row)
            if item:
                items.append(item)

    # 3. If still no items, try thermal POS 2-line parser
    if not items:
        thermal_items = _parse_thermal_items(text_rows)
        if thermal_items:
            items.extend(thermal_items)

    # Secondary HSN tax table lookup (e.g., HSN 1005: 9% Central + 9% State = 18%)
    hsn_tax_map: dict[str, int] = {}
    for hsn_m in re.finditer(r"\b(\d{4,8})\s+[\d,.]+\s+(\d{1,2})%\s+[\d,.]+\s+(\d{1,2})%", full_text):
        hsn_code = hsn_m.group(1)
        cgst_r = int(hsn_m.group(2))
        sgst_r = int(hsn_m.group(3))
        hsn_tax_map[hsn_code] = cgst_r + sgst_r
    for hsn_m in re.finditer(r"\b(\d{4,8})\s+[\d,.]+\s+(\d{1,2})%\s+[\d,.]+", full_text):
        hsn_code = hsn_m.group(1)
        if hsn_code not in hsn_tax_map:
            hsn_tax_map[hsn_code] = int(hsn_m.group(2))

    for it in items:
        if it.get("gst") is None and it.get("hsn") in hsn_tax_map:
            it["gst"] = hsn_tax_map[it["hsn"]]

    # Financial Totals & Consistency
    subtotal_match = re.search(rf"{SUBTOTAL_LABEL}\s*[:=-]?\s*{MONEY}", full_text, re.I)
    printed_subtotal = _clean_money(subtotal_match.group(1)) if subtotal_match else grid_totals.get("subtotal")

    total_match = re.search(rf"{TOTAL_LABEL}\s*[:=-]?\s*{MONEY}", full_text, re.I)
    printed_total = _clean_money(total_match.group(1)) if total_match else grid_totals.get("grandTotal")

    tax_match = re.search(rf"{TAX_LABEL}\s*[:=-]?\s*{MONEY}", full_text, re.I)
    printed_tax = grid_totals.get("totalTax")
    if printed_tax is None and tax_match:
        val = _clean_money(tax_match.group(1))
        if val is not None and (printed_total is None or val < printed_total):
            printed_tax = val

    # Detect Tax-Exclusive vs Tax-Inclusive mode
    # If items have taxable + tax_amount == amount, or subtotal + tax == total: Tax-Exclusive!
    has_taxable_cols = any(it.get("taxable") is not None for it in items)
    is_tax_exclusive = False
    if has_taxable_cols and printed_subtotal and printed_tax and printed_total:
        if abs((printed_subtotal + printed_tax) - printed_total) < 1.0:
            is_tax_exclusive = True
    elif has_taxable_cols:
        is_tax_exclusive = True

    # Process and normalize items
    normalized_items = []
    total_taxable = 0.0
    total_gst_amount = 0.0
    computed_item_total = 0.0

    for it in items:
        name = it.get("name", "Item")
        qty = it.get("qty")
        if qty is None:
            qty = 1.0  # fallback for calculation, but keep raw flags if needed

        rate = it.get("rate")
        mrp = it.get("mrp")
        gst = it.get("gst")
        amount = it.get("amount")

        # Missing field handling (Test 8 requirements)
        if rate is None and amount is not None and qty > 0:
            rate = amount / qty
        elif amount is None and rate is not None and qty > 0:
            amount = qty * rate

        if mrp is None:
            mrp = rate

        if amount is None:
            amount = 0.0
        if rate is None:
            rate = 0.0

        amount = round(amount, 2)
        rate = round(rate, 2)
        mrp = round(mrp, 2) if mrp is not None else None

        # Tax calculations
        gst_pct = gst if gst is not None else 0
        if gst is None:
            flags.append({"type": "warn", "code": "missing_gst", "msg": f"GST rate is missing for {name}."})

        if is_tax_exclusive:
            taxable = it.get("taxable") or round(qty * rate, 2)
            gst_amt = round(taxable * (gst_pct / 100.0), 2)
            item_total = it.get("amount") or round(taxable + gst_amt, 2)
        else:
            item_total = amount
            taxable = round(item_total / (1.0 + gst_pct / 100.0), 2)
            gst_amt = round(item_total - taxable, 2)

        cgst = round(gst_amt / 2.0, 2)
        sgst = round(gst_amt / 2.0, 2)
        igst = 0.0

        total_taxable += taxable
        total_gst_amount += gst_amt
        computed_item_total += item_total

        normalized_items.append({
            "name": name,
            "qty": qty,
            "uom": it.get("uom"),
            "hsn": it.get("hsn"),
            "mrp": mrp,
            "rate": rate,
            "gst": gst,
            "taxable": taxable,
            "cgst": cgst,
            "sgst": sgst,
            "igst": igst,
            "gstAmt": gst_amt,
            "taxType": "CGST_SGST",
            "total": item_total
        })

    computed_item_total = round(computed_item_total, 2)
    total_gst_amount = round(total_gst_amount, 2)

    # Commercial invoice signals check
    has_commercial_signals = bool(re.search(
        r"\b(invoice|bill|receipt|tax|gstin|gst|cgst|sgst|igst|hsn|sac|mrp|taxable|subtotal|grand\s*total|"
        r"balance\s*due|amount\s*due|qty|quantity|retail\s*invoice|tax\s*invoice|cash\s*memo|pos\s*receipt|"
        r"vch\s*no|voucher|supplier|vendor|purchaser|billed\s*to|shipped\s*to)\b",
        full_text,
        re.I
    )) or bool(re.search(r"(?:₹|rs\.?|inr)\s*\d+", full_text, re.I))

    # Flags and validation
    if not normalized_items:
        if not has_commercial_signals or (printed_total is None or printed_total == 0):
            flags.insert(0, {
                "type": "error",
                "code": "non_bill_document",
                "msg": "False document detected: This file does not appear to be a commercial invoice or bill (no line items or financial totals detected)."
            })
            vendor = "Unrecognized Non-Bill Document"
        else:
            flags.append({"type": "error", "code": "no_items", "msg": "No line items could be parsed from this invoice."})

    if printed_total is not None and computed_item_total > 0:
        if abs(printed_total - computed_item_total) > 1.0:
            flags.append({
                "type": "warn",
                "code": "total_mismatch",
                "msg": f"Printed total ₹{printed_total:.2f} differs from extracted items total ₹{computed_item_total:.2f}."
            })

    if printed_tax is not None and total_gst_amount > 0:
        if abs(printed_tax - total_gst_amount) > 1.5:
            flags.append({
                "type": "warn",
                "code": "tax_mismatch",
                "msg": f"Printed GST ₹{printed_tax:.2f} differs from extracted GST ₹{total_gst_amount:.2f}."
            })

    if not gstin_val:
        flags.append({"type": "warn", "code": "no_gstin", "msg": "No GSTIN found — input tax credit cannot be claimed."})

    # Slab totals
    slabs: dict[str, dict[str, float]] = {}
    for it in normalized_items:
        s_key = str(it["gst"] if it["gst"] is not None else 0)
        if s_key not in slabs:
            slabs[s_key] = {"taxable": 0.0, "gstAmt": 0.0, "total": 0.0}
        slabs[s_key]["taxable"] += it["taxable"]
        slabs[s_key]["gstAmt"] += it["gstAmt"]
        slabs[s_key]["total"] += it["total"]

    for k in slabs:
        slabs[k]["taxable"] = round(slabs[k]["taxable"], 2)
        slabs[k]["gstAmt"] = round(slabs[k]["gstAmt"], 2)
        slabs[k]["total"] = round(slabs[k]["total"], 2)

    grand_total = printed_total if printed_total is not None else computed_item_total

    return {
        "store": vendor,
        "billNo": bill_no or f"BILL-{datetime.now().strftime('%H%M%S')}",
        "date": date_val,
        "gstin": gstin_val,
        "items": normalized_items,
        "slabs": slabs,
        "computedItemTotal": computed_item_total,
        "printedTotal": printed_total,
        "grandTotal": grand_total,
        "totalGSTAmt": total_gst_amount,
        "printedGST": printed_tax,
        "flags": flags,
        "reviewRequired": len(flags) > 0 or printed_total is None,
        "parser": "finbotics-universal-spatial-v3"
    }
