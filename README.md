# FinBotics — Neural OCR & Automated Financial Accounting Engine

<div align="center">

![FinBotics Architecture](https://img.shields.io/badge/OCR-PaddleOCR%20v3-0D47A1?style=for-the-badge&logo=python)
![Computer Vision](https://img.shields.io/badge/Vision-OpenCV%20Preprocessed-1E4D35?style=for-the-badge&logo=opencv)
![Backend](https://img.shields.io/badge/API-FastAPI%20%2B%20SQLite-009688?style=for-the-badge&logo=fastapi)
![Design](https://img.shields.io/badge/Design-Editorial%20Swiss%20Minimalism-2B2922?style=for-the-badge)
![Privacy](https://img.shields.io/badge/Security-100%25%20On--Device%20%2F%20Zero%20Data%20Egress-388E3C?style=for-the-badge)

**An intelligent document-processing and enterprise bookkeeping platform that parses physical receipts, PDF tax invoices, and store bills into verified accounting ledger entries with automated GST reconciliation and Tally/Excel export.**

[Live Prototype Guide](#-asap-deployment-options) • [Features](#-core-capabilities) • [Tech Stack](#-technical-stack) • [Quickstart](#-local-quickstart)

</div>

---

## ✦ Core Capabilities

1. **Dual Ingestion Pipelines**:
   - **Neural PaddleOCR Engine**: High-accuracy deep-learning text extraction with OpenCV preprocessing (Tenengrad autofocus grading, variance-of-Laplacian blur scoring, Hough transform deskewing, and adaptive contrast stretching).
   - **Digital Vector PDF Parser**: Instant client-side spatial vector parser powered by PDF.js with boundary-box line reconstruction.
   - **Live Desktop & Device Camera**: Real-time camera viewfinder with snapshot capture for instant bill digitisation.

2. **Automated Tax & Math Audit**:
   - Multi-slab GST extraction (0%, 3%, 5%, 12%, 18%, 28%) with automatic CGST, SGST, and IGST ledger mapping.
   - Financial variance verification: Cross-compares computed line totals against printed bill totals.
   - Rate vs. MRP anomaly detection: Flags any items billed above their maximum retail price.
   - Vendor GSTIN 15-character checksum format verification.

3. **Accounting & ERP Interoperability**:
   - **Tally XML Voucher Export**: One-click download of XML vouchers formatted according to standard Tally Prime import schema.
   - **Excel (XLSX) Export**: 3-sheet structured workbook containing Line Items, GST Tax Breakdown, and Vendor Audit Summary.
   - **CSV Export**: Clean tabular export with auto-classified expense ledgers.

4. **FinBot On-Device Assistant**:
   - Natural-language financial assistant running locally on-device (via Ollama and lightweight neural fallbacks).

---

## ✦ Technical Stack

| Layer | Technologies |
|---|---|
| **Frontend UI/UX** | HTML5, CSS3 Editorial Design System (Cormorant Garamond + Plus Jakarta Sans + JetBrains Mono), Vanilla JS, Three.js, PDF.js, SheetJS (XLSX) |
| **Backend API** | Python 3.11, FastAPI, Uvicorn (ASGI) |
| **Document AI & Vision** | PaddleOCR (PP-OCRv4), OpenCV (cv2), NumPy |
| **Database & Cache** | SQLite3 with auto-normalizing data layer & SHA-256 OCR response caching |
| **Containerization** | Docker, Docker Compose |

---

## ✦ ASAP Deployment Options

### Option 1: 1-Click Railway Deployment (Fastest Full Prototype)
Railway handles large deep-learning Python packages (like PaddleOCR and OpenCV) with up to 8GB of build RAM:
1. Go to [railway.app](https://railway.app) and sign in with GitHub.
2. Click **New Project** > **Deploy from GitHub repo**.
3. Select `moksh-09/FinBotics_New`.
4. Railway will auto-detect the `Dockerfile` or `requirements.txt` and deploy.
5. In **Settings** > **Networking**, click **Generate Domain** to get your public HTTPS URL!

---

### Option 2: Render.com Deployment
1. Go to [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** > **Web Service**.
3. Connect repository `moksh-09/FinBotics_New`.
4. Render will read `render.yaml` or use:
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
5. Click **Deploy Web Service**.

---

### Option 3: Instant 60-Second Live Public Demo (Via ngrok)
If you need an immediate working prototype link with your local Gemma 3 (4B) and PaddleOCR active:
```bash
# 1. Start your local server
uvicorn backend.main:app --host 127.0.0.1 --port 8010

# 2. In a second terminal, open a public HTTPS tunnel:
ngrok http 8010
```
Copy the forwarding URL (e.g. `https://xxxx.ngrok-free.app`) and open it on any mobile or desktop device.

---

## ✦ Local Quickstart

### Prerequisites
- Python 3.10+
- Git

### Installation
```bash
# Clone the repository
git clone https://github.com/moksh-09/FinBotics_New.git
cd FinBotics_New

# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run application
uvicorn backend.main:app --host 127.0.0.1 --port 8010 --reload
```
Open **[http://127.0.0.1:8010](http://127.0.0.1:8010)** in your browser.

---

## ✦ Project Structure

```text
FinBotics_New/
├── backend/
│   ├── main.py                  # FastAPI server routes & static file endpoints
│   ├── invoice_parser.py        # Spatial heuristics & line item extractor
│   ├── ocr/
│   │   └── paddle_engine.py     # PaddleOCR engine singleton wrapper
│   └── preprocessing/
│       └── image_quality.py     # OpenCV quality validation & deskewing
├── landing.html                 # Editorial high-converting landing page
├── auth.html                    # Editorial authentication screen
├── index.html                   # Main dashboard, vault & live camera workspace
├── script.js                    # Client application logic, exports & state sync
├── style.css                    # Luxury editorial stylesheet
├── Dockerfile                   # Production container definition
├── render.yaml                  # 1-click cloud configuration
├── Procfile                     # Process runner declaration
├── requirements.txt             # Python runtime dependencies
└── README.md                    # Project documentation
```

---

## ✦ License & Data Privacy Guarantee
FinBotics operates with a zero cloud-leakage guarantee. When deployed locally or on a private VPS, all images, invoice metadata, and ledger entries remain strictly enclosed on the server disk with zero telemetry or commercial LLM egress.
