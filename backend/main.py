from pathlib import Path
import os
import sqlite3
import json
import io
import hashlib
import urllib.request

import cv2
import numpy as np

from fastapi import (
    FastAPI,
    File,
    HTTPException,
    UploadFile
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from backend.preprocessing.image_quality import (
    assess_image_quality,
    preprocess_image,
    validate_ocr_result
)
from backend.ocr.paddle_engine import PaddleOCREngine
from backend.invoice_parser import parse_invoice

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("FINBOTICS_DB", ROOT / "finbotics.sqlite3"))
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    conn.execute("CREATE TABLE IF NOT EXISTS ocr_cache (hash TEXT PRIMARY KEY, response TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    return conn


app = FastAPI(
    title="FinBotics Universal Invoice Intelligence API",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)


def get_ocr_engine():
    return PaddleOCREngine()


@app.api_route("/", methods=["GET", "HEAD"])
def root():
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/landing", status_code=302)


@app.api_route("/landing", methods=["GET", "HEAD"])
def landing():
    return FileResponse(ROOT / "landing.html", headers={"Cache-Control": "no-cache"})


@app.api_route("/auth", methods=["GET", "HEAD"])
def auth_page():
    return FileResponse(ROOT / "auth.html", headers={"Cache-Control": "no-cache"})


@app.api_route("/app", methods=["GET", "HEAD"])
def app_page():
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-cache, must-revalidate"})


@app.api_route("/favicon.ico", methods=["GET", "HEAD"])
def favicon():
    return Response(status_code=204)


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "FinBotics",
        "version": app.version,
        "app_url": "http://127.0.0.1:8010/"
    }


@app.get("/api/status")
def api_status():
    return {
        "service": "FinBotics",
        "version": app.version,
        "ocr_engine": "PaddleOCR (Optimized)",
        "parser": "Universal Spatial & Layout-Aware Parser v3",
        "storage": "SQLite",
    }


@app.api_route("/style.css", methods=["GET", "HEAD"])
def frontend_css():
    return FileResponse(ROOT / "style.css", media_type="text/css", headers={"Cache-Control": "no-cache, must-revalidate"})


@app.api_route("/script.js", methods=["GET", "HEAD"])
def frontend_js():
    return FileResponse(ROOT / "script.js", media_type="application/javascript", headers={"Cache-Control": "no-cache, must-revalidate"})


@app.post("/api/ocr")
async def run_ocr(file: UploadFile = File(...)):
    """Fast, neural-optimized OCR on uploaded image bill."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded image is empty.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 25 MB limit.")

    image_array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    try:
        # Step 1: Quality assessment (<15ms)
        quality = assess_image_quality(image)

        # Step 2: Adaptive neural-friendly preprocessing
        processed_image, preprocessing = preprocess_image(image, quality)

        # Step 3: PaddleOCR recognition
        result = get_ocr_engine().recognize(processed_image)

        # Step 4: Spatial layout & financial parsing
        validation = validate_ocr_result(result)
        structured_invoice = parse_invoice(result["text"], result["lines"])
        structured_invoice["source"] = "paddle_ocr"

    except Exception as error:
        raise HTTPException(status_code=500, detail=f"OCR processing error: {error}")

    return {
        "status": "processed",
        "filename": Path(file.filename or "invoice.jpg").name,
        "engine": result["engine"],
        "text": result["text"],
        "lines": result["lines"],
        "average_confidence": result["average_confidence"],
        "quality": quality["quality"],
        "quality_details": quality,
        "preprocessing": preprocessing["method"],
        "preprocessing_details": preprocessing,
        "validation": validation,
        "structured_invoice": structured_invoice,
    }


@app.post("/api/process-bill")
async def process_bill(file: UploadFile = File(...)):
    """Unified bill processing endpoint: handles digital PDFs, scanned PDFs, and images."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds upload limit.")

    file_hash = hashlib.sha256(raw).hexdigest()
    try:
        with db() as conn:
            cached_row = conn.execute("SELECT response FROM ocr_cache WHERE hash=?", (file_hash,)).fetchone()
            if cached_row:
                cached_data = json.loads(cached_row["response"])
                cached_data["cached"] = True
                return cached_data
    except Exception:
        pass

    filename = Path(file.filename or "bill").name
    ext = filename.split(".")[-1].lower() if "." in filename else ""

    if ext == "pdf" or (file.content_type and "pdf" in file.content_type):
        try:
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(raw)
            num_pages = len(pdf)

            # Try digital text extraction first
            all_text_lines = []
            has_sufficient_text = False
            total_chars = 0

            for page_idx in range(num_pages):
                page = pdf[page_idx]
                textpage = page.get_textpage()
                page_text = textpage.get_text_range()
                if page_text:
                    total_chars += len(page_text.strip())
                    all_text_lines.append(page_text)

            if total_chars > 50:
                # Digital PDF path: instant extraction (<50ms)!
                full_text = "\n".join(all_text_lines)
                structured = parse_invoice(full_text)
                structured["source"] = "digital_pdf"
                resp = {
                    "status": "processed",
                    "filename": filename,
                    "engine": "PDF.js / PyPDFium2 Digital Extraction",
                    "text": full_text,
                    "lines": [{"text": l} for l in full_text.splitlines() if l.strip()],
                    "quality": "good",
                    "quality_details": {"type": "digital_pdf", "pages": num_pages, "characters": total_chars},
                    "structured_invoice": structured,
                }
                try:
                    with db() as conn:
                        conn.execute("INSERT OR REPLACE INTO ocr_cache(hash, response) VALUES(?, ?)", (file_hash, json.dumps(resp)))
                except Exception:
                    pass
                return resp
            else:
                # Scanned PDF path: render pages and OCR
                all_lines = []
                full_texts = []
                for page_idx in range(min(num_pages, 5)):
                    page = pdf[page_idx]
                    bitmap = page.render(scale=1.5)
                    pil_image = bitmap.to_pil()
                    img_np = np.array(pil_image)
                    if len(img_np.shape) == 3 and img_np.shape[2] == 3:
                        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
                    elif len(img_np.shape) == 3 and img_np.shape[2] == 4:
                        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGBA2BGR)
                    else:
                        img_bgr = img_np

                    q = assess_image_quality(img_bgr)
                    p_img, prep = preprocess_image(img_bgr, q)
                    ocr_res = get_ocr_engine().recognize(p_img)
                    all_lines.extend(ocr_res["lines"])
                    full_texts.append(ocr_res["text"])

                full_text = "\n".join(full_texts)
                structured = parse_invoice(full_text, all_lines)
                structured["source"] = "scanned_pdf"
                resp = {
                    "status": "processed",
                    "filename": filename,
                    "engine": "PaddleOCR (Scanned PDF)",
                    "text": full_text,
                    "lines": all_lines,
                    "quality": "scanned_pdf",
                    "quality_details": {"pages": num_pages},
                    "structured_invoice": structured,
                }
                try:
                    with db() as conn:
                        conn.execute("INSERT OR REPLACE INTO ocr_cache(hash, response) VALUES(?, ?)", (file_hash, json.dumps(resp)))
                except Exception:
                    pass
                return resp
        except Exception as err:
            raise HTTPException(status_code=500, detail=f"PDF extraction error: {err}")

    # Otherwise treat as image
    image_array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Unsupported or unreadable file format.")

    try:
        quality = assess_image_quality(image)
        p_img, prep = preprocess_image(image, quality)
        result = get_ocr_engine().recognize(p_img)
        validation = validate_ocr_result(result)
        structured = parse_invoice(result["text"], result["lines"])
        structured["source"] = "paddle_ocr"

        resp = {
            "status": "processed",
            "filename": filename,
            "engine": result["engine"],
            "text": result["text"],
            "lines": result["lines"],
            "average_confidence": result["average_confidence"],
            "quality": quality["quality"],
            "quality_details": quality,
            "preprocessing": prep["method"],
            "preprocessing_details": prep,
            "validation": validation,
            "structured_invoice": structured,
        }
        try:
            with db() as conn:
                conn.execute("INSERT OR REPLACE INTO ocr_cache(hash, response) VALUES(?, ?)", (file_hash, json.dumps(resp)))
        except Exception:
            pass
        return resp
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"OCR error: {err}")


@app.post("/api/parse-text")
def parse_text(payload: dict):
    """Normalize selectable text through the universal layout-aware parser."""
    text = str(payload.get("text", ""))
    lines = payload.get("lines")
    if not text.strip():
        raise HTTPException(status_code=400, detail="Document text is empty.")
    if len(text) > 1_000_000:
        raise HTTPException(status_code=413, detail="Document text exceeds limit.")
    return {"structured_invoice": parse_invoice(text, lines)}


def normalize_invoice_dict(inv: dict) -> dict:
    if not isinstance(inv, dict):
        return {}
    d = dict(inv)
    d["id"] = str(d.get("id") or "")
    d["store"] = d.get("store") or "Store / Vendor"
    d["billNo"] = d.get("billNo") or "BILL-000"
    d["date"] = d.get("date") or ""
    d["gstin"] = d.get("gstin") or ""
    d["source"] = d.get("source") or "paddle_ocr"

    raw_items = d.get("items")
    if not isinstance(raw_items, list):
        raw_items = []

    clean_items = []
    total_taxable = 0.0
    total_gst = 0.0
    computed_items_total = 0.0
    slabs = {}

    for it in raw_items:
        if not isinstance(it, dict):
            continue
        try:
            qty = float(it.get("qty") or 1)
        except (ValueError, TypeError):
            qty = 1.0
        try:
            rate = float(it.get("rate") or 0)
        except (ValueError, TypeError):
            rate = 0.0
        try:
            mrp = float(it.get("mrp") or rate)
        except (ValueError, TypeError):
            mrp = rate
        try:
            gst = float(it.get("gst") or 0)
        except (ValueError, TypeError):
            gst = 0.0

        total = it.get("total")
        try:
            total = float(total) if total is not None else round(qty * rate, 2)
        except (ValueError, TypeError):
            total = round(qty * rate, 2)

        taxable = it.get("taxable")
        try:
            taxable = float(taxable) if taxable is not None else round(total / (1 + gst / 100.0), 2)
        except (ValueError, TypeError):
            taxable = round(total / (1 + gst / 100.0), 2)

        gst_amt = it.get("gstAmt")
        try:
            gst_amt = float(gst_amt) if gst_amt is not None else round(total - taxable, 2)
        except (ValueError, TypeError):
            gst_amt = round(total - taxable, 2)

        cgst = it.get("cgst")
        try:
            cgst = float(cgst) if cgst is not None else round(gst_amt / 2.0, 2)
        except (ValueError, TypeError):
            cgst = round(gst_amt / 2.0, 2)

        sgst = it.get("sgst")
        try:
            sgst = float(sgst) if sgst is not None else round(gst_amt / 2.0, 2)
        except (ValueError, TypeError):
            sgst = round(gst_amt / 2.0, 2)

        clean_items.append({
            "name": it.get("name") or "Item",
            "qty": qty,
            "mrp": mrp,
            "rate": rate,
            "gst": gst,
            "taxable": taxable,
            "gstAmt": gst_amt,
            "cgst": cgst,
            "sgst": sgst,
            "igst": float(it.get("igst") or 0),
            "total": total,
            "uom": it.get("uom"),
            "hsn": it.get("hsn")
        })
        total_taxable += taxable
        total_gst += gst_amt
        computed_items_total += total

        k = str(int(gst) if gst.is_integer() else gst)
        if k not in slabs:
            slabs[k] = {"taxable": 0.0, "gstAmt": 0.0, "total": 0.0}
        slabs[k]["taxable"] = round(slabs[k]["taxable"] + taxable, 2)
        slabs[k]["gstAmt"] = round(slabs[k]["gstAmt"] + gst_amt, 2)
        slabs[k]["total"] = round(slabs[k]["total"] + total, 2)

    d["items"] = clean_items
    if not d.get("slabs"):
        d["slabs"] = slabs
    d["computedItemTotal"] = round(computed_items_total, 2)

    if d.get("totalGSTAmt") is None:
        d["totalGSTAmt"] = round(total_gst, 2)
    else:
        try:
            d["totalGSTAmt"] = float(d["totalGSTAmt"])
        except (ValueError, TypeError):
            d["totalGSTAmt"] = round(total_gst, 2)

    if d.get("grandTotal") is None:
        d["grandTotal"] = round(computed_items_total, 2)
    else:
        try:
            d["grandTotal"] = float(d["grandTotal"])
        except (ValueError, TypeError):
            d["grandTotal"] = round(computed_items_total, 2)

    if not isinstance(d.get("flags"), list):
        d["flags"] = []
    return d


@app.get("/api/invoices")
def list_invoices():
    with db() as conn:
        rows = conn.execute("SELECT data FROM invoices ORDER BY updated_at DESC").fetchall()
    return {"invoices": [normalize_invoice_dict(json.loads(row["data"])) for row in rows]}


@app.put("/api/invoices/{invoice_id}")
def save_invoice(invoice_id: str, invoice: dict):
    if not isinstance(invoice, dict):
        raise HTTPException(status_code=400, detail="Invoice must be a JSON object.")
    payload = normalize_invoice_dict(invoice)
    payload["id"] = invoice_id
    with db() as conn:
        conn.execute(
            "INSERT INTO invoices(id, data, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP",
            (invoice_id, json.dumps(payload))
        )
    return {"status": "saved", "invoice": payload}


@app.delete("/api/invoices/{invoice_id}")
def delete_invoice(invoice_id: str):
    with db() as conn:
        conn.execute("DELETE FROM invoices WHERE id=?", (invoice_id,))
    return {"status": "deleted"}


@app.delete("/api/invoices")
def clear_invoices():
    with db() as conn:
        conn.execute("DELETE FROM invoices")
    return {"status": "cleared"}


# ─── FINBOT ASSISTANT: OLLAMA & GEMMA 3 (4B) INTEGRATION ───
OLLAMA_BASE_URL = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")


def get_ollama_model():
    """Detect installed models and return gemma3:4b or best available model."""
    try:
        req = urllib.request.Request(f"{OLLAMA_BASE_URL}/api/tags", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            models = [m.get("name") or m.get("model") for m in data.get("models", [])]
            for m in models:
                if "gemma3" in m:
                    return m, models
            for m in models:
                if "gemma" in m:
                    return m, models
            if models:
                return models[0], models
    except Exception:
        pass
    return "gemma3:4b", []


@app.get("/api/chat/status")
def chat_status():
    """Check Ollama availability and detected local LLM model."""
    selected_model, models = get_ollama_model()
    is_online = False
    try:
        req = urllib.request.Request(f"{OLLAMA_BASE_URL}/api/tags", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            is_online = (resp.status == 200)
    except Exception:
        is_online = False
    return {
        "online": is_online,
        "selected_model": selected_model,
        "available_models": models,
        "ollama_url": OLLAMA_BASE_URL
    }


@app.post("/api/chat")
def chat_with_finbot(payload: dict):
    """
    Chat endpoint powered by local Gemma 3:4B via Ollama.
    Accepts query, optional bills context, and conversation history.
    """
    query = str(payload.get("query", "")).strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    bills = payload.get("bills")
    # If bills not supplied by client, fetch from database
    if bills is None:
        with db() as conn:
            rows = conn.execute("SELECT data FROM invoices ORDER BY updated_at DESC LIMIT 30").fetchall()
            bills = [json.loads(row["data"]) for row in rows]

    # Calculate summary numbers
    total_spend = sum(float(b.get("grandTotal") or b.get("computedItemTotal") or 0) for b in bills)
    total_gst = sum(float(b.get("totalGSTAmt") or 0) for b in bills)
    flagged_bills = [b for b in bills if (b.get("flags") or [])]
    stores = sorted(list({b.get("store") for b in bills if b.get("store")}))

    # Compact invoices context for prompt
    compact_invoices = []
    for b in bills[:20]:
        items_summary = [f"{it.get('name')} (qty {it.get('qty', 1)}, ₹{it.get('total', 0)}, GST {it.get('gst', 0)}%)" for it in (b.get("items") or [])[:8]]
        flags_summary = [f.get("msg") for f in (b.get("flags") or []) if isinstance(f, dict) and f.get("msg")]
        compact_invoices.append({
            "store": b.get("store"),
            "billNo": b.get("billNo"),
            "date": b.get("date"),
            "gstin": b.get("gstin"),
            "total": b.get("grandTotal"),
            "gstAmt": b.get("totalGSTAmt"),
            "items": items_summary,
            "flags": flags_summary
        })

    model, models = get_ollama_model()

    system_prompt = (
        "You are FinBot, the financial intelligence assistant for FinBotics.\n"
        "You run entirely ON-DEVICE for complete privacy.\n"
        "CRITICAL: Do not mention or refer to yourself by any underlying model or platform names such as Gemma, LLaMA, Ollama, Google, or any other LLM name. Always refer to yourself simply as FinBot.\n"
        "You specialize in Indian GST laws (0%, 3%, 5%, 12%, 18%, 28%), invoice analysis, audit validation, and TallyPrime reconciliation.\n"
        "Guidelines:\n"
        "- Answer the user's question clearly, concisely, and professionally using Markdown formatting (bold, bullet points).\n"
        "- Always use the Indian Rupee symbol (₹) for monetary amounts.\n"
        "- Base your analysis on the live invoice vault data provided below.\n"
        "- If the user asks about spend, taxes, flags, or vendors, cite exact numbers and store names from the data.\n"
        "- If the vault is empty, guide the user to scan a bill, use the camera, or load a template.\n"
    )

    context_str = (
        f"LIVE FINBOTICS LEDGER DATA:\n"
        f"- Total Invoices: {len(bills)}\n"
        f"- Total Spend: ₹{total_spend:,.2f}\n"
        f"- Total Claimable Input GST: ₹{total_gst:,.2f}\n"
        f"- Flagged Invoices: {len(flagged_bills)}\n"
        f"- Unique Stores/Vendors: {', '.join(stores) if stores else 'None'}\n"
        f"- Recent Invoice Details:\n{json.dumps(compact_invoices, indent=2)}\n"
    )

    full_prompt = f"{system_prompt}\n{context_str}\nUSER QUERY: {query}\n\nASSISTANT RESPONSE:"

    # Attempt calling Ollama
    try:
        ollama_req = urllib.request.Request(
            f"{OLLAMA_BASE_URL}/api/generate",
            data=json.dumps({
                "model": model,
                "prompt": full_prompt,
                "stream": False,
                "options": {
                    "temperature": 0.3,
                    "top_p": 0.9,
                    "num_predict": 512
                }
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(ollama_req, timeout=45) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            answer = data.get("response", "").strip()
            return {
                "reply": answer,
                "model": "on_device",
                "source": "on_device",
                "status": "success"
            }
    except Exception as err:
        return {
            "reply": f"⚠️ Could not reach local AI service: {str(err)}.\n\nMake sure your local on-device service is running.",
            "model": "on_device",
            "source": "error_fallback",
            "status": "error"
        }
