# FinBotics

**FinBotics** is a prototype for converting bills and invoices into
structured business data that can be reviewed and exported for
downstream bookkeeping workflows. The current implementation combines a
browser-based interface, a FastAPI backend for image OCR, OpenCV-based
image-quality assessment/preprocessing, and a PaddleOCR wrapper.

> **Project status:** Prototype / work in progress. This README
> describes the functionality and code structure visible in the project
> materials shared so far. Some components---especially the connection
> between OCR, structured invoice reconstruction, validation, and the
> frontend---must be verified against the currently running code before
> they are described as fully integrated.

------------------------------------------------------------------------

## Contents

-   [Project goal](#project-goal)
-   [Current capabilities](#current-capabilities)
-   [Architecture](#architecture)
-   [Processing workflows](#processing-workflows)
-   [Technology stack](#technology-stack)
-   [Project structure](#project-structure)
-   [Backend setup](#backend-setup)
-   [Run the FastAPI server](#run-the-fastapi-server)
-   [API overview](#api-overview)
-   [Image-quality and invoice-processing
    logic](#image-quality-and-invoice-processing-logic)
-   [Exports and output](#exports-and-output)
-   [Known issues and integration
    checks](#known-issues-and-integration-checks)
-   [Testing roadmap](#testing-roadmap)
-   [Future development priorities](#future-development-priorities)

------------------------------------------------------------------------

## Project goal

Manual transfer of invoice information into spreadsheets or accounting
systems is repetitive and prone to transcription and column-mapping
errors. Bills also vary in layout, image quality, column order, tax
treatment, and the fields they contain.

FinBotics aims to reduce this manual effort by:

1.  Accepting a bill as a digital PDF or an image.
2.  Extracting text from the document.
3.  Reconstructing invoice metadata and line-item fields.
4.  Checking extraction quality and financial consistency.
5.  Showing the extracted data for review.
6.  Exporting normalized data to supported formats, including CSV/Excel
    and Tally-compatible XML where the current implementation supports
    it.

The intended principle is that **uncertain values should be flagged or
left unresolved rather than silently invented**.

## Current capabilities

The following reflects the project materials shared so far. Confirm each
flow in the running application before treating it as production-ready.

  --------------------------------------------------------------------------------
  Component               Current implementation /         Status note
                          evidence                         
  ----------------------- -------------------------------- -----------------------
  Web interface           `index.html`, `style.css`,       Prototype UI; test
                          `script.js`; interface includes  every action end to end
                          bill-scanning, dashboard,        
                          invoice and export-related       
                          functionality                    

  Digital PDF processing  Frontend uses PDF.js and         Separate from the image
                          JavaScript-side parsing for      OCR route
                          digital PDFs                     

  Image upload / OCR API  FastAPI route in                 Backend route exists in
                          `backend/main.py` accepts an     the shared code
                          uploaded image and processes it  snapshot
                          using OpenCV and the OCR wrapper 

  Image quality           OpenCV/NumPy metrics for         Implemented in the
  assessment              blur/focus, brightness,          shared
                          contrast, dark/white pixel       `image_quality.py` code
                          ratios, edge density and skew    

  Image preprocessing     Conditional upscaling,           Operations depend on
                          sharpening, CLAHE, denoising,    quality signals
                          adaptive thresholding and        
                          deskewing                        

  OCR                     PaddleOCR wrapper in             Verify installed
                          `backend/ocr/paddle_engine.py`   dependencies and
                                                           returned response
                                                           format

  Invoice reconstruction  Shared `image_quality.py`        Verify it is called by
                          contains logic for metadata,     the active API route
                          headers, column centres, row     
                          grouping and field mapping       

  OCR validation          Shared code checks confidence,   Verify it is called by
                          suspicious financial text, GST   the active API route
                          percentages and overlapping OCR  
                          regions                          

  Financial consistency   Shared code compares taxable     Rule-based checks;
                          subtotal, line-item amounts, GST invoice tax modes and
                          and grand total where values are rounding need broader
                          available                        testing

  Export                  Frontend contains CSV/Excel and  Validate output against
                          Tally XML export-related         representative records
                          functions                        and the target
                                                           accounting system
  --------------------------------------------------------------------------------

------------------------------------------------------------------------

## Architecture

``` text
                         ┌─────────────────────────────┐
                         │         User / UI           │
                         │ index.html + style.css      │
                         │          script.js          │
                         └──────────────┬──────────────┘
                                        │
                       ┌────────────────┴────────────────┐
                       │                                 │
                 Digital PDF                         Image / Photo
                       │                                 │
               PDF.js + JavaScript              FastAPI image endpoint
                       │                                 │
              PDF text extraction               OpenCV image decoding
                       │                                 │
              Frontend parsing rules            Quality assessment
                       │                                 │
                       │                         Conditional preprocessing
                       │                                 │
                       │                              PaddleOCR
                       │                                 │
                       └────────────────┬────────────────┘
                                        │
                              Normalized OCR / text data
                                        │
                           Invoice field reconstruction
                                        │
                              Validation and checks
                                        │
                              Review / correction UI
                                        │
                        CSV / Excel / Tally XML export
```

### Backend responsibilities

-   **FastAPI (`backend/main.py`)**: creates the API application,
    handles upload requests, decodes images, invokes quality
    assessment/preprocessing and calls the OCR engine.
-   **Image quality module (`backend/preprocessing/image_quality.py`)**:
    measures image quality, decides whether preprocessing is needed,
    applies selected transformations, and---in the fuller shared
    version---contains OCR validation and invoice-field reconstruction
    helpers.
-   **PaddleOCR wrapper (`backend/ocr/paddle_engine.py`)**: isolates OCR
    engine initialization and converts OCR output into a predictable
    representation for the rest of the application.

### Frontend responsibilities

-   **`index.html`**: page layout and UI structure.
-   **`style.css`**: styling and responsive presentation.
-   **`script.js`**: file selection/routing, PDF parsing, API calls for
    image OCR, result rendering, invoice state and export-related
    functions.

------------------------------------------------------------------------

## Processing workflows

### Workflow A: Digital PDF

1.  The user selects a PDF.
2.  The frontend uses PDF.js to inspect/extract selectable text where
    available.
3.  JavaScript parsing rules identify invoice-like fields and line
    items.
4.  The frontend normalizes and displays the parsed data.
5.  The user can review and use supported export actions.

**Limitation:** image-only/scanned PDFs may not contain selectable text.
Those require a PDF-to-image/OCR route, which should be verified
separately rather than assumed to work through the digital-text path.

### Workflow B: Image or photograph

1.  The frontend uploads the image to the FastAPI endpoint.
2.  The backend verifies that the upload can be decoded.
3.  OpenCV converts the image to grayscale for measurement and
    calculates quality indicators.
4.  The quality decision is classified as `good`, `needs_preprocessing`,
    or `reject`.
5.  If required, the preprocessing function applies selected
    transformations.
6.  PaddleOCR returns recognized text and, where provided, confidence
    scores and bounding boxes.
7.  The browser applies rule-based grocery receipt parsing to infer
    metadata and line items from extracted text.
8.  Validation checks OCR quality; the browser flags a mismatch when a
    labelled printed total can be found and differs from extracted items.
9.  The frontend should display extracted data and highlight unresolved
    or suspicious values.
10. Normalized records can then be exported using supported formats.

**Current integration:** `/api/ocr` calls image-quality assessment,
preprocessing, PaddleOCR and `validate_ocr_result()`. It returns OCR
text, lines, confidence and quality signals. The current structured
receipt parser runs in `script.js`; there is no backend
`reconstruct_invoice_fields()` implementation in this repository.

------------------------------------------------------------------------

## Technology stack

  -----------------------------------------------------------------------
  Technology                          Purpose
  ----------------------------------- -----------------------------------
  Python                              Backend and invoice-processing
                                      logic

  FastAPI                             HTTP API for image uploads and OCR
                                      processing

  Uvicorn                             Local ASGI server for FastAPI

  OpenCV (`cv2`)                      Image decoding, image processing
                                      and quality measurements

  NumPy                               Image arrays and numerical
                                      calculations

  PaddleOCR                           Text recognition from bill images

  HTML                                Frontend structure

  CSS                                 Frontend styling

  JavaScript                          Client-side interactions, parsing,
                                      API requests and exports

  PDF.js                              Reading digital PDF content in the
                                      browser
  -----------------------------------------------------------------------

Check `requirements.txt` for the exact pinned package versions. The
project has been run in a Python 3.13 virtual environment in the shared
terminal output, but compatibility of every dependency should be
confirmed in the current environment.

------------------------------------------------------------------------

## Project structure

The following is the structure visible in the project materials shared
so far. Some files or directories may exist beyond this snapshot.

``` text
FinBotics_App/
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   ├── ocr/
│   │   └── paddle_engine.py
│   └── preprocessing/
│       └── image_quality.py
├── index.html
├── script.js
├── style.css
└── .venv/                  # Local virtual environment; do not commit
```

Other files, tests, sample invoices and configuration files may be
present in the actual repository. Keep secrets, API keys, local virtual
environments, caches and private invoice data out of version control.

------------------------------------------------------------------------

## Backend setup

Run commands from the **project root**---the directory containing
`backend/`, `index.html`, `script.js` and `style.css`.

### 1. Open the project directory

If your project folder is named `FinBotics_App paddle ocr` and is under
Downloads:

``` bash
cd "/Users/mokshmathukia/Downloads/FinBotics_App paddle ocr"
```

Adjust the path if the project has moved.

### 2. Activate the virtual environment

``` bash
source .venv/bin/activate
```

Your terminal prompt should show `(.venv)` after activation.

If the virtual environment does not exist, create it:

``` bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install dependencies

Inspect the repository's dependency files first. If `requirements.txt`
is in `backend/`, run:

``` bash
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
```

If the project has a root-level `requirements.txt` instead, use that
file. Avoid installing both sets blindly if they conflict.

### 4. Check Python and imports

``` bash
python --version
python -c "import fastapi, uvicorn, cv2, numpy; print('Core imports OK')"
```

PaddleOCR may require additional packages and system libraries. If its
import fails, check the exact error and the versions declared by the
project rather than randomly upgrading dependencies.

------------------------------------------------------------------------

## Run the FastAPI server

From the **project root**, use the package-qualified module path:

``` bash
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8010
```

Then open:

-   FinBotics app: `http://127.0.0.1:8010/`
-   API base: `http://127.0.0.1:8010/api/status`
-   Swagger/OpenAPI UI: `http://127.0.0.1:8010/docs`
-   ReDoc: `http://127.0.0.1:8010/redoc`

Stop the server with **Ctrl+C**.

### Common import error

If you see:

``` text
ModuleNotFoundError: No module named 'preprocessing'
```

the import path inside `backend/main.py` may not match the way Uvicorn
is launched. For a launch from the project root using
`backend.main:app`, imports may need to be package-qualified, for
example:

``` python
from backend.preprocessing.image_quality import (
    assess_image_quality,
    preprocess_image,
    validate_ocr_result,
)
from backend.ocr.paddle_engine import PaddleOCREngine
```

Use the imports that match the actual folder structure and package
setup. Do not mix `backend.main:app` with assumptions that `backend/`
itself is the Python import root. Also check whether package
`__init__.py` files are required by the project's chosen setup.

------------------------------------------------------------------------

## API overview

The backend serves the browser app at `http://127.0.0.1:8010/` and exposes persistent invoice and OCR routes. Port 8010 is deliberate: port 8000 is commonly occupied by another local project. Open `/api/status` to confirm that the server responding is FinBotics. Digital PDFs are parsed by PDF.js; scanned PDF pages are rendered in the browser and submitted individually to the image OCR endpoint. Image OCR uses PaddleOCR after OpenCV quality assessment and preprocessing. Invoice storage uses a local SQLite file (`finbotics.sqlite3`, override with `FINBOTICS_DB`).

The image OCR route is:

``` text
POST /api/ocr
```

It accepts an uploaded image as multipart form data (20 MB and 30 megapixel prototype limits). Invoice records can be listed with `GET /api/invoices`, saved with `PUT /api/invoices/{id}`, deleted with `DELETE /api/invoices/{id}`, and cleared with `DELETE /api/invoices`. The precise
response fields should be confirmed in the active `backend/main.py`
implementation.

A useful target response contract for the complete pipeline is:

``` json
{
  "status": "accepted",
  "filename": "invoice.png",
  "engine": "PaddleOCR",
  "text": "recognized text",
  "lines": [
    {
      "text": "Grand Total 1254.54",
      "confidence": 0.98,
      "box": [[10, 20], [180, 20], [180, 45], [10, 45]]
    }
  ],
  "quality_details": {
    "quality_action": "good",
    "issues": []
  },
  "preprocessing_details": {
    "operations": []
  },
  "validation": {
    "valid": true,
    "issues": [],
    "warnings": []
  },
  "structured_invoice": {
    "fields": {
      "vendor": null,
      "invoice_number": null,
      "date": null,
      "gstin": null,
      "subtotal": null,
      "total_gst": null,
      "grand_total": null
    },
    "items": [],
    "flags": [],
    "financial_validation": {}
  }
}
```

This is a **recommended target schema**, not a guarantee that the
current endpoint returns every field above. Keep API output stable and
let the frontend handle optional/missing values without crashing.

------------------------------------------------------------------------

## Image-quality and invoice-processing logic

The shared `image_quality.py` implementation includes the following
concepts.

### Image-quality signals

-   **Laplacian variance:** one indicator of high-frequency
    detail/focus.
-   **Tenengrad/gradient energy:** another indicator of image edges and
    focus.
-   **Edge density:** proportion of pixels classified as edges.
-   **Brightness and contrast:** help identify dark, overexposed or
    low-contrast images.
-   **Black/white ratios:** help detect nearly blank or severely dark
    images.
-   **Skew angle:** estimates document rotation using line candidates.
-   **Document-region estimate:** a weak geometric signal, not a
    definitive document detector.

These signals should be considered together. Their thresholds depend on
resolution, text density, print quality and invoice layout.

### Preprocessing operations

Depending on measured conditions, the code may:

-   upscale small images;
-   sharpen when multiple indicators support blur;
-   apply CLAHE for relevant lighting or contrast problems;
-   denoise when degradation is supported;
-   apply adaptive thresholding as a poor-visibility fallback;
-   deskew when the estimated angle is large enough to justify
    correction.

### OCR validation

The shared validation helper checks for:

-   no usable OCR lines;
-   low and very low confidence lines;
-   merged financial fields;
-   suspicious GST percentage tokens;
-   incomplete invoice-structure signals;
-   overlapping OCR boxes.

### Invoice reconstruction

The shared reconstruction helper attempts to:

-   extract vendor, invoice number, date and GSTIN;
-   detect table headers and their horizontal centres;
-   group OCR tokens into rows using vertical positions;
-   map item, quantity, UOM, HSN, rate, discount, tax and amount fields;
-   calculate derived values only when the required source values exist;
-   compare printed totals with extracted line-item totals;
-   flag missing metadata and financial inconsistencies.

**Important:** rule-based parsing is not guaranteed to generalize to
every invoice. Different layouts, tax modes, column arrangements and OCR
mistakes require a labelled test set and regression tests.

------------------------------------------------------------------------

## Exports and output

The frontend materials include export-related functions for:

-   **CSV**
-   **Excel**
-   **Tally XML**

The normalized invoice record---not raw OCR text---should be the source
for exports. Before relying on these outputs, test:

-   missing optional fields;
-   special characters in vendor and item names;
-   multiple line items;
-   quantities and units;
-   multiple GST rates;
-   CGST/SGST versus IGST;
-   tax-inclusive and tax-exclusive prices;
-   discounts and rounding;
-   malformed or unresolved values.

Tally XML should be tested against the expected import format in the
target Tally environment. Do not treat the existence of an export button
as proof that every generated file imports correctly.

------------------------------------------------------------------------

## Known issues and integration checks

1.  **Import-path consistency:** the previous startup attempt failed
    with `ModuleNotFoundError: No module named 'preprocessing'`.
    Launching from the project root with `backend.main:app` requires
    imports consistent with that package layout.
2.  **Structured extraction:** the browser currently uses heuristic
    grocery-receipt parsing. It is not a general invoice reconstruction
    model and needs a reviewed, labelled evaluation set before wider use.
3.  **GST summary extraction:** a previously discussed sample showed
    `total_gst` unresolved even though the OCR text appeared to contain
    a printed GST value. Add a regression test for labels and amounts
    split across separate OCR tokens.
4.  **PDF versus image consistency:** normalize both paths to the same
    invoice schema so the dashboard and exports do not behave
    differently depending on the input type.
5.  **OCR confidence versus correctness:** a high OCR confidence does
    not prove that a value was assigned to the correct column or that
    the bill is authentic.
6.  **OCR engine:** image and scanned-PDF processing use PaddleOCR.
    Older unused browser preprocessing helpers should be removed during
    a future cleanup to avoid confusion.
7.  **Error handling:** invalid images, empty OCR output, missing fields
    and malformed bounding boxes should produce controlled responses
    rather than uncaught exceptions.
8.  **CORS and upload limits:** broad CORS settings may be acceptable
    for local experimentation but should be restricted for deployment.
    Add file-size and processing-time limits.
9.  **Persistence:** confirm whether invoice records are stored only in
    browser state/local storage or persisted on a backend before
    claiming multi-device or cloud storage.
10. **Test coverage:** passing one sample invoice is not sufficient
    evidence of robustness across vendors and layouts.

------------------------------------------------------------------------

## Testing roadmap

Build a ground-truth test set with manually checked invoice fields and
line items. Include:

  -----------------------------------------------------------------------
  Dimension                           Examples
  ----------------------------------- -----------------------------------
  Image quality                       Sharp, blurred, dark, overexposed,
                                      shadowed, skewed and
                                      perspective-distorted

  Input type                          Digital PDF, scanned PDF, phone
                                      photo and cropped image

  Layout                              Different header names/order,
                                      missing columns, wrapped
                                      descriptions and no table grid

  Tax                                 GST-inclusive/exclusive, CGST+SGST,
                                      IGST, discounts and rounding

  Metadata                            Different date and invoice-number
                                      formats; missing GSTIN or vendor
                                      title

  OCR failures                        Merged numbers, lost decimal
                                      points, low confidence and
                                      overlapping boxes

  Export                              Many items, missing values, special
                                      characters and multiple tax rates
  -----------------------------------------------------------------------

Measure more than whether the API returns HTTP 200. Useful metrics
include:

-   field-level exact-match accuracy;
-   line-item row detection precision/recall;
-   quantity, rate, tax and amount accuracy;
-   invoice-total exact match within a defined rounding tolerance;
-   financial reconciliation rate;
-   percentage of invoices requiring human review;
-   failure/crash rate across all test inputs;
-   performance on vendors/layouts excluded from development tuning.

------------------------------------------------------------------------

## Future development priorities

### Priority 1 --- Make the existing pipeline reliable

-   Fix and standardize Python package imports.
-   Verify the active API route end to end.
-   Connect OCR output to reconstruction, validation and the frontend.
-   Establish one normalized invoice schema for all input routes.
-   Add controlled error handling and regression tests.

### Priority 2 --- Improve extraction reliability

-   Preserve evidence for each field: source OCR text, bounding box and
    confidence.
-   Track uncertainty per field/row rather than relying only on a
    document-wide average.
-   Improve handling of split labels, variable column layouts, units and
    tax modes.
-   Use financial reconciliation as a cross-check, not as a way to
    fabricate missing printed values.
-   Add a review workflow for uncertain or conflicting fields.

### Priority 3 --- Demonstrate generalization

-   Build a diverse, manually labelled invoice corpus.
-   Evaluate on unseen vendors and layouts.
-   Compare the current rules-based approach against appropriate
    baselines.
-   Record failure categories and improve the system based on measured
    results.

### Priority 4 --- Evaluate distinctiveness

Potential areas to investigate include evidence-aware extraction,
uncertainty propagation, selective correction, cross-field
reconciliation and generalization to unseen invoice layouts. These are
development directions, not claims of unique novelty. Any claim that a
feature has never been implemented elsewhere requires a separate
competitor and literature review.

------------------------------------------------------------------------

## Contributing / development notes

-   Keep OCR, image preprocessing, reconstruction, validation and export
    logic separated into testable modules.
-   Add a regression test whenever a bug is fixed for a specific
    invoice.
-   Do not tune thresholds only for one bill.
-   Keep real invoices and sensitive business data out of public
    repositories unless appropriately anonymized and authorized.
-   Do not commit `.venv/`, caches, credentials or local configuration
    secrets.
-   Document the exact Python and dependency versions used for a tested
    release.

## License

No license information was provided in the project materials reviewed
for this README. Add a license file and update this section before
distributing the project publicly.


## Hybrid prototype notes

- Digital PDFs use browser text extraction. Scanned pages use the PaddleOCR backend; mixed PDFs use text extraction per page and OCR where a page has no selectable text. Images are sent to the same OCR endpoint.
- Extracted records are drafts. The current product-specific field parser is heuristic and mainly tuned for grocery receipts; confirm values against the source before exporting. No prototype can guarantee correct processing for every invoice layout, language, currency, handwritten document, or tax regime.
- Run the app through FastAPI (not by opening `index.html` directly): `python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8010`. Install `backend/requirements.txt` first. PaddleOCR may need model downloads on first run and supported Python/PaddlePaddle versions.
- Local SQLite is for prototyping only. It has no users, authentication, backups, encryption, or multi-user isolation. Do not store sensitive production invoices here.
