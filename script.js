pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ─── GLOBAL STATE ─── */
const DB = { bills: [] };
const OCRDB = DB; // Unified database
let _pend = null;
let _ocrPend = null;

/* ─── CONSTANTS & LOOKUPS ─── */
const GCLS = { 0: 'g0', 3: 'g0', 5: 'g5', 12: 'g12', 18: 'g18', 28: 'g28' };
const GCOL = { 0: '#4caf50', 3: '#8bc34a', 5: '#ff9800', 12: '#2196f3', 18: '#9c27b0', 28: '#f44336' };

const PG = {
  scanner:   ['Bill Scanner', 'Drop any bill or invoice — instant text or neural OCR extraction'],
  ocr:       ['OCR Scanner', 'Upload or capture bill photos — neural quality assessment & PaddleOCR'],
  dashboard: ['Dashboard', 'Live stats and financial summary from your invoices'],
  invoices:  ['All Invoices', 'Complete searchable archive of all scanned and saved bills'],
  reconcile: ['Reconcile', 'Review flagged bills (Rate > MRP, missing GSTIN, total mismatches)'],
  analysis:  ['Analysis', 'GST slab distribution and category spending breakdown'],
  settings:  ['Settings', 'Configuration and local SQLite database management'],
};

/* ─── SIDEBAR & NAVIGATION ─── */
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sb-overlay');
  if (sb && ov) {
    sb.classList.toggle('open');
    ov.classList.toggle('open');
  }
}

document.querySelectorAll('.sb-link[data-pg]').forEach(el => {
  el.addEventListener('click', () => {
    goPage(el.dataset.pg);
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sb-overlay');
    if (sb && sb.classList.contains('open')) toggleSidebar();
  });
});

function goPage(pg) {
  document.querySelectorAll('.sb-link[data-pg]').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.page').forEach(x => x.classList.remove('on'));
  document.querySelector(`.sb-link[data-pg="${pg}"]`)?.classList.add('on');
  document.getElementById(`pg-${pg}`)?.classList.add('on');
  const m = PG[pg] || [pg, ''];
  document.getElementById('pg-title').textContent = m[0];
  document.getElementById('pg-sub').textContent = m[1];

  if (pg === 'dashboard') renderDash();
  if (pg === 'invoices')  renderInvoices();
  if (pg === 'reconcile') renderReconcile();
  if (pg === 'analysis')  renderAnalysis();
}

/* ─── FILE & LIVE CAMERA TRIGGER HANDLERS ─── */
let _cameraStream = null;
let _cameraTargetMode = 'modal';
let _cameraFacing = 'environment';

function triggerFile() { document.getElementById('file-in').click(); }
function triggerOCRFile() { document.getElementById('ocr-file-in').click(); }

function openCamera() { openLiveCamera('modal'); }
function openOCRCamera() { openLiveCamera('ocr_page'); }

async function openLiveCamera(targetMode = 'modal') {
  _cameraTargetMode = targetMode;
  const modal = document.getElementById('camera-modal');
  const video = document.getElementById('camera-video');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Live camera not supported in this browser. Opening file dialog…', 'warn');
    if (targetMode === 'ocr_page') document.getElementById('ocr-camera-in').click();
    else document.getElementById('camera-in').click();
    return;
  }

  try {
    if (_cameraStream) {
      _cameraStream.getTracks().forEach(t => t.stop());
    }

    modal.classList.add('show');
    toast('Accessing desktop camera…', 'info');

    const constraints = {
      video: {
        facingMode: _cameraFacing,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };

    _cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (video) {
      video.srcObject = _cameraStream;
      await video.play();
    }
  } catch (err) {
    console.warn('Camera error:', err);
    if (modal) modal.classList.remove('show');
    toast('Camera error: ' + (err.message || 'Permission denied') + '. Fallback to file picker.', 'warn');
    if (targetMode === 'ocr_page') document.getElementById('ocr-camera-in').click();
    else document.getElementById('camera-in').click();
  }
}

function captureLivePhoto() {
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  if (!video || !canvas || !_cameraStream) {
    toast('Camera stream not ready', 'warn');
    return;
  }

  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  canvas.toBlob(blob => {
    if (!blob) {
      toast('Failed to capture frame from camera', 'error');
      return;
    }
    const filename = 'desktop_live_bill_' + Date.now() + '.jpg';
    const file = new File([blob], filename, { type: 'image/jpeg' });
    closeLiveCamera();
    toast('✓ Snapshot captured! Parsing invoice via OCR…', 'success');
    processBill(file, _cameraTargetMode);
  }, 'image/jpeg', 0.95);
}

function closeLiveCamera() {
  const modal = document.getElementById('camera-modal');
  if (modal) modal.classList.remove('show');
  if (_cameraStream) {
    _cameraStream.getTracks().forEach(track => track.stop());
    _cameraStream = null;
  }
}

async function switchCameraDevice() {
  _cameraFacing = _cameraFacing === 'environment' ? 'user' : 'environment';
  await openLiveCamera(_cameraTargetMode);
}

function handleFile(inp) {
  const f = inp.files[0]; inp.value = '';
  if (!f) return;
  processBill(f, 'modal');
}

function handleOCRFile(inp) {
  const f = inp.files[0]; inp.value = '';
  if (!f) return;
  processBill(f, 'ocr_page');
}

/* ─── DRAG & DROP ─── */
['dragover', 'dragleave', 'drop'].forEach(ev => {
  ['dz', 'm-dz', 'ocr-dz'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'dragover') el.classList.add('drag');
      else if (ev === 'dragleave') el.classList.remove('drag');
      else {
        el.classList.remove('drag');
        const f = e.dataTransfer.files[0];
        if (f) processBill(f, id === 'ocr-dz' ? 'ocr_page' : 'modal');
      }
    });
  });
});

/* ─── MODAL CONTROLS ─── */
function openModal() { document.getElementById('scan-modal').classList.add('show'); resetModal(); }
function closeModal() { document.getElementById('scan-modal').classList.remove('show'); }
function closeDet() { document.getElementById('det-modal').classList.remove('show'); }
function resetModal() { S('m-up'); H('m-prog'); H('m-res'); }

document.getElementById('scan-modal')?.addEventListener('click', e => { if (e.target === document.getElementById('scan-modal')) closeModal(); });
document.getElementById('det-modal')?.addEventListener('click', e => { if (e.target === document.getElementById('det-modal')) closeDet(); });
document.getElementById('camera-modal')?.addEventListener('click', e => { if (e.target === document.getElementById('camera-modal')) closeLiveCamera(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeDet();
    closeLiveCamera();
  }
});

/* ─── UNIFIED BILL PROCESSOR (PDF + IMAGES) ─── */
async function processBill(file, mode = 'modal') {
  const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|tiff)$/i.test(file.name);
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

  if (!isImage && !isPdf) {
    toast('Please upload a PDF or an Image bill.', 'warn');
    return;
  }

  if (mode === 'modal') {
    openModal(); S('m-prog'); H('m-up'); H('m-res');
    document.getElementById('m-fname').textContent = file.name;
    setProg(10);
    setStages([
      { l: 'Inspecting document', s: 'run' },
      { l: 'Recognizing text & layout', s: 'wait' },
      { l: 'Spatial field extraction', s: 'wait' },
      { l: 'Tax & totals validation', s: 'wait' },
    ]);
  } else {
    // OCR Page mode
    document.getElementById('ocr-processing').style.display = '';
    document.getElementById('ocr-results').style.display = 'none';
    document.getElementById('ocr-pbar').style.width = '15%';
    document.getElementById('ocr-status').textContent = 'Preparing image…';
    document.getElementById('ocr-quality-stage').textContent = '1. Assessing image quality…';
    document.getElementById('ocr-preprocess-stage').textContent = '2. Adaptive preprocessing: pending';
    document.getElementById('ocr-engine-stage').textContent = '3. PaddleOCR: pending';

    // Show preview if image
    if (isImage) {
      const reader = new FileReader();
      reader.onload = e => {
        document.getElementById('ocr-preview-img').src = e.target.result;
        document.getElementById('ocr-preview-wrap').style.display = '';
      };
      reader.readAsDataURL(file);
    }
  }

  try {
    let parsed = null;

    if (isPdf) {
      // 1. Try instant PDF.js text extraction (<30ms)
      if (mode === 'modal') { setProg(25); sDone(0); sRun(1); }
      const pdfRes = await extractTextFromPdf(file).catch(() => ({ fullText: '', lines: [] }));
      const textFromPdf = pdfRes.fullText || '';
      const linesFromPdf = pdfRes.lines || [];

      if (textFromPdf && textFromPdf.trim().length > 40) {
        if (mode === 'modal') { setProg(55); sDone(1); sRun(2); }
        // Fast backend parse or client fallback
        parsed = await requestParsedText(textFromPdf, linesFromPdf).catch(() => null);
        if (!parsed || !parsed.items || !parsed.items.length) {
          parsed = parseGroceryClient(textFromPdf, file.name);
        }
        parsed.source = 'digital_pdf';
      } else {
        // Scanned PDF -> send to backend unified processor
        if (mode === 'modal') { setProg(40); sDone(0); sRun(1); }
        else {
          document.getElementById('ocr-pbar').style.width = '45%';
          document.getElementById('ocr-status').textContent = 'Scanned PDF: running PaddleOCR…';
        }
        const res = await sendFileToApi(file);
        parsed = res.structured_invoice;
        parsed.rawText = res.text;
      }
    } else {
      // Image upload -> PaddleOCR pipeline
      if (mode === 'modal') {
        setProg(30); sDone(0); sRun(1);
      } else {
        document.getElementById('ocr-pbar').style.width = '40%';
        document.getElementById('ocr-status').textContent = 'Running PaddleOCR neural recognition…';
        document.getElementById('ocr-quality-stage').textContent = '1. Image quality assessed ✓';
        document.getElementById('ocr-preprocess-stage').textContent = '2. Neural-optimized preprocessing applied ✓';
        document.getElementById('ocr-engine-stage').textContent = '3. PaddleOCR in progress…';
      }

      const res = await sendFileToApi(file);
      parsed = res.structured_invoice;
      parsed.qualityDetails = res.quality_details;
      parsed.validation = res.validation;
      parsed.rawText = res.text;

      if (mode === 'ocr_page') {
        document.getElementById('ocr-engine-stage').textContent = '3. PaddleOCR complete ✓';
        document.getElementById('ocr-raw-text').textContent = res.text || '(No text recognized)';
      }
    }

    // Normalize & validate draft
    parsed = normalizeDraft(parsed, file.name);

    if (mode === 'modal') {
      setProg(100); sDone(2); sDone(3);
      showResult(parsed);
    } else {
      document.getElementById('ocr-pbar').style.width = '100%';
      document.getElementById('ocr-status').textContent = 'Extraction complete!';
      document.getElementById('ocr-processing').style.display = 'none';
      showOCRResult(parsed);
    }

  } catch (err) {
    console.error('Processing error:', err);
    if (mode === 'modal') {
      toast('Failed to process bill: ' + (err.message || 'unknown error'), 'error');
      resetModal();
    } else {
      document.getElementById('ocr-processing').style.display = 'none';
      toast('OCR failed: ' + (err.message || 'unknown error'), 'error');
    }
  }
}

/* ─── PDF TEXT EXTRACTION (IN BROWSER) ─── */
async function extractTextFromPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = '';
  const lines = [];

  for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
    const page = await pdf.getPage(i);
    const ct = await page.getTextContent();
    const yMap = {};

    ct.items.forEach(item => {
      let s = String(item.str || '')
        .replace(/[■□▪▫●◆◇★☆]/g, '')
        .replace(/Rs\.?\s*/gi, '')
        .replace(/₹\s*/g, '')
        .trim();
      if (!s) return;
      const x = Math.round(item.transform[4] || 0);
      const y = Math.round(item.transform[5] || 0);
      const w = Math.round(item.width || 20);
      const h = Math.round(item.height || 12);
      const clusterY = Math.round(y / 4) * 4;
      if (!yMap[clusterY]) yMap[clusterY] = [];
      yMap[clusterY].push({ x, w, h, s });
      lines.push({
        text: s,
        confidence: 1.0,
        box: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      });
    });

    Object.keys(yMap).sort((a, b) => +b - +a).forEach(y => {
      const line = yMap[y].sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim();
      if (line) fullText += line + '\n';
    });
  }
  return { fullText, lines };
}

/* ─── API CALLS ─── */
async function sendFileToApi(file) {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/process-bill', { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || 'Server processing error');
  return data;
}

async function requestParsedText(text, lines = null) {
  const response = await fetch('/api/parse-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lines }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || 'Parsing error');
  return data.structured_invoice;
}

async function persistInvoice(invoice) {
  try {
    await fetch(`/api/invoices/${encodeURIComponent(invoice.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invoice)
    });
  } catch (e) {
    console.warn('SQLite persistence error:', e);
  }
}

function normalizeBill(b) {
  if (!b || typeof b !== 'object') return null;
  const bill = { ...b };
  bill.id = bill.id ? String(bill.id) : String(Date.now() + Math.floor(Math.random() * 100000));
  bill.store = bill.store || 'Store / Vendor';
  bill.billNo = bill.billNo || 'BILL-000';
  bill.date = bill.date || new Date().toISOString().split('T')[0];
  bill.gstin = bill.gstin || '';
  bill.source = bill.source || 'paddle_ocr';
  bill.flags = Array.isArray(bill.flags) ? bill.flags : [];

  const rawItems = Array.isArray(bill.items) ? bill.items : [];
  bill.items = rawItems.map(it => {
    const qty = Number(it.qty) || 1;
    const rate = Number(it.rate) || 0;
    const mrp = (it.mrp !== undefined && it.mrp !== null && !isNaN(Number(it.mrp))) ? Number(it.mrp) : rate;
    const gst = Number(it.gst) || 0;
    const total = (it.total !== undefined && it.total !== null && !isNaN(Number(it.total)))
      ? Number(it.total)
      : Number((qty * rate).toFixed(2));
    const taxable = (it.taxable !== undefined && it.taxable !== null && !isNaN(Number(it.taxable)))
      ? Number(it.taxable)
      : Number((total / (1 + gst / 100)).toFixed(2));
    const gstAmt = (it.gstAmt !== undefined && it.gstAmt !== null && !isNaN(Number(it.gstAmt)))
      ? Number(it.gstAmt)
      : Number((total - taxable).toFixed(2));
    const cgst = (it.cgst !== undefined && it.cgst !== null && !isNaN(Number(it.cgst)))
      ? Number(it.cgst)
      : Number((gstAmt / 2).toFixed(2));
    const sgst = (it.sgst !== undefined && it.sgst !== null && !isNaN(Number(it.sgst)))
      ? Number(it.sgst)
      : Number((gstAmt / 2).toFixed(2));
    const igst = Number(it.igst) || 0;

    return {
      name: it.name || 'Item',
      qty,
      mrp,
      rate,
      gst,
      taxable,
      gstAmt,
      cgst,
      sgst,
      igst,
      total,
      uom: it.uom || null,
      hsn: it.hsn || null
    };
  });

  const slabs = (bill.slabs && typeof bill.slabs === 'object') ? { ...bill.slabs } : {};
  if (Object.keys(slabs).length === 0 && bill.items.length > 0) {
    bill.items.forEach(it => {
      const k = String(it.gst);
      if (!slabs[k]) slabs[k] = { taxable: 0, gstAmt: 0, total: 0 };
      slabs[k].taxable = +(slabs[k].taxable + it.taxable).toFixed(2);
      slabs[k].gstAmt = +(slabs[k].gstAmt + it.gstAmt).toFixed(2);
      slabs[k].total = +(slabs[k].total + it.total).toFixed(2);
    });
  }
  bill.slabs = slabs;

  const computedTotal = +bill.items.reduce((s, i) => s + (Number(i.total) || 0), 0).toFixed(2);
  const computedGST = +bill.items.reduce((s, i) => s + (Number(i.gstAmt) || 0), 0).toFixed(2);

  bill.computedItemTotal = computedTotal;
  bill.totalGSTAmt = (bill.totalGSTAmt !== undefined && bill.totalGSTAmt !== null && !isNaN(Number(bill.totalGSTAmt)))
    ? Number(bill.totalGSTAmt)
    : computedGST;

  bill.grandTotal = (bill.grandTotal !== undefined && bill.grandTotal !== null && !isNaN(Number(bill.grandTotal)))
    ? Number(bill.grandTotal)
    : (bill.printedTotal !== null && bill.printedTotal !== undefined && !isNaN(Number(bill.printedTotal)))
      ? Number(bill.printedTotal)
      : computedTotal;

  return bill;
}

async function loadInvoices() {
  try {
    const res = await fetch('/api/invoices');
    if (!res.ok) return;
    const data = await res.json();
    const rawList = Array.isArray(data.invoices) ? data.invoices : [];
    DB.bills = rawList.map(normalizeBill).filter(Boolean);
    updateSB();
    renderRecent();
    renderOCRRecent();
    const cur = document.querySelector('.sb-link.on')?.dataset.pg;
    if (cur === 'dashboard') renderDash();
    if (cur === 'invoices')  renderInvoices();
    if (cur === 'reconcile') renderReconcile();
    if (cur === 'analysis')  renderAnalysis();
  } catch (err) {
    console.error('loadInvoices error:', err);
  }
}

/* ─── INVOICE STATUS BADGE HELPER ─── */
function getBillBadge(flags) {
  const fl = flags || [];
  if (!fl.length) {
    return {
      status: 'ok',
      text: 'Verified',
      cls: 'badge-ok',
      icon: 'fa-check',
      html: '<span class="badge badge-ok"><i class="fas fa-check"></i> Verified</span>'
    };
  }

  const hasErrors = fl.some(f => f.type === 'error');
  if (hasErrors) {
    return {
      status: 'flagged',
      text: 'Flagged',
      cls: 'badge-warn',
      icon: 'fa-flag',
      html: `<span class="badge badge-warn" title="${fl.map(f => f.msg).join('; ')}"><i class="fas fa-flag"></i> Flagged (${fl.length})</span>`
    };
  }

  // Only warnings (e.g. items with missing GST or missing GSTIN) -> show Warning!
  return {
    status: 'warn',
    text: 'Warning',
    cls: 'badge-amber',
    icon: 'fa-triangle-exclamation',
    html: `<span class="badge badge-amber" title="${fl.map(f => f.msg).join('; ')}"><i class="fas fa-triangle-exclamation"></i> Warning</span>`
  };
}

/* ─── DRAFT NORMALIZATION & FINANCIAL MATH ─── */
function normalizeDraft(draft, filename) {
  const fallbackDate = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const items = (draft.items || []).map(it => {
    const qty = Number(it.qty) > 0 ? Number(it.qty) : 1;
    const rate = Number(it.rate) || 0;
    const mrp = Number(it.mrp) !== undefined && it.mrp !== null ? Number(it.mrp) : rate;
    const gst = it.gst !== null && it.gst !== undefined ? Number(it.gst) : 0;
    const total = Number(it.total) || Number(it.amount) || Number((qty * rate).toFixed(2));
    const taxable = Number(it.taxable) || Number((total / (1 + gst / 100)).toFixed(2));
    const gstAmt = Number(it.gstAmt) || Number((total - taxable).toFixed(2));

    return {
      name: String(it.name || 'Unidentified item').replace(/[<>]/g, '').trim(),
      qty,
      mrp,
      rate,
      gst,
      taxable,
      cgst: Number((gstAmt / 2).toFixed(2)),
      sgst: Number((gstAmt / 2).toFixed(2)),
      igst: 0,
      gstAmt,
      total,
      uom: it.uom || null,
      hsn: it.hsn || null,
    };
  });

  const slabs = {};
  items.forEach(it => {
    const k = String(it.gst);
    if (!slabs[k]) slabs[k] = { taxable: 0, gstAmt: 0, total: 0 };
    slabs[k].taxable += it.taxable;
    slabs[k].gstAmt += it.gstAmt;
    slabs[k].total += it.total;
  });
  Object.keys(slabs).forEach(k => {
    slabs[k].taxable = +slabs[k].taxable.toFixed(2);
    slabs[k].gstAmt = +slabs[k].gstAmt.toFixed(2);
    slabs[k].total = +slabs[k].total.toFixed(2);
  });

  const computedTotal = +items.reduce((s, i) => s + i.total, 0).toFixed(2);
  const totalGSTAmt = +items.reduce((s, i) => s + i.gstAmt, 0).toFixed(2);
  const printedTotal = draft.printedTotal !== null && draft.printedTotal !== undefined ? Number(draft.printedTotal) : null;
  const grandTotal = printedTotal !== null ? printedTotal : computedTotal;

  // Re-check validation flags
  const flags = [...(draft.flags || [])];

  // False document detection (document containing non-bill content)
  const fullContent = ((draft.rawText || '') + ' ' + (draft.store || '') + ' ' + (draft.billNo || '') + ' ' + (filename || '')).toLowerCase();
  const hasCommercialSignals = /\b(invoice|bill|receipt|tax|gstin|gst|cgst|sgst|igst|hsn|sac|mrp|taxable|subtotal|grand\s*total|balance\s*due|amount\s*due|retail\s*invoice|tax\s*invoice|cash\s*memo|pos\s*receipt|vch\s*no|voucher|supplier|vendor)\b/i.test(fullContent) || /(?:₹|rs\.?|inr)\s*\d+/i.test(fullContent);

  if (!items.length) {
    if (!hasCommercialSignals || (!printedTotal || printedTotal === 0)) {
      if (!flags.some(f => f.code === 'non_bill_document')) {
        flags.unshift({
          type: 'error',
          code: 'non_bill_document',
          msg: 'False document detected: This file does not appear to be a commercial invoice or bill (no line items or billing totals detected).'
        });
      }
    } else if (!flags.some(f => f.code === 'no_items')) {
      flags.push({ type: 'error', code: 'no_items', msg: 'No line items detected' });
    }
  }

  // Ensure missing GST flags are marked as 'warn'
  flags.forEach(f => {
    if (f.code === 'missing_gst') f.type = 'warn';
  });

  if (!draft.gstin && !flags.some(f => f.code === 'no_gstin')) {
    flags.push({ type: 'warn', code: 'no_gstin', msg: 'No GSTIN on bill — input credit cannot be claimed' });
  }

  const isNonBill = flags.some(f => f.code === 'non_bill_document');
  const storeName = isNonBill
    ? 'Unrecognized Non-Bill Document'
    : (draft.store || detectStoreClient(fullContent, (filename || '').toLowerCase()));

  return {
    ...draft,
    id: draft.id || Date.now(),
    store: storeName,
    billNo: draft.billNo || `BILL-${Date.now().toString().slice(-6)}`,
    date: draft.date || fallbackDate,
    gstin: draft.gstin || '',
    items,
    slabs,
    flags,
    computedItemTotal: computedTotal,
    printedTotal,
    grandTotal,
    totalGSTAmt,
    source: draft.source || 'paddle_ocr',
    reviewRequired: flags.length > 0
  };
}

function recalculateDraft(draft) {
  let totalTaxable = 0;
  let totalGst = 0;
  let computedTotal = 0;
  const slabs = {};

  draft.items.forEach(it => {
    const qty = Number(it.qty) || 1;
    const rate = Number(it.rate) || 0;
    const gst = Number(it.gst) || 0;
    const total = Number(it.total) !== undefined ? Number(it.total) : Number((qty * rate).toFixed(2));
    const taxable = Number((total / (1 + gst / 100)).toFixed(2));
    const gstAmt = Number((total - taxable).toFixed(2));

    it.qty = qty;
    it.rate = rate;
    it.total = total;
    it.taxable = taxable;
    it.gstAmt = gstAmt;
    it.cgst = Number((gstAmt / 2).toFixed(2));
    it.sgst = Number((gstAmt / 2).toFixed(2));

    totalTaxable += taxable;
    totalGst += gstAmt;
    computedTotal += total;

    const k = String(gst);
    if (!slabs[k]) slabs[k] = { taxable: 0, gstAmt: 0, total: 0 };
    slabs[k].taxable += taxable;
    slabs[k].gstAmt += gstAmt;
    slabs[k].total += total;
  });

  draft.computedItemTotal = +computedTotal.toFixed(2);
  draft.totalGSTAmt = +totalGst.toFixed(2);
  draft.slabs = slabs;
  draft.grandTotal = (draft.printedTotal != null && !isNaN(draft.printedTotal))
    ? Number(draft.printedTotal)
    : (draft.grandTotal != null && !isNaN(draft.grandTotal) ? Number(draft.grandTotal) : draft.computedItemTotal);

  // Rate vs MRP check
  draft.flags = (draft.flags || []).filter(f => f.code !== 'rate_above_mrp');
  draft.items.forEach(it => {
    if (it.mrp && it.rate > it.mrp) {
      draft.flags.push({
        type: 'warn',
        code: 'rate_above_mrp',
        msg: `Rate (₹${it.rate.toFixed(2)}) exceeds MRP (₹${it.mrp.toFixed(2)}) for ${it.name}.`
      });
    }
  });

  return draft;
}

/* ─── LIVE DRAFT ITEM EDITING ─── */
function updateDraftItem(kind, index, field, value) {
  const draft = kind === 'ocr' ? _ocrPend : _pend;
  if (!draft || !draft.items[index]) return;

  const item = draft.items[index];
  if (field === 'name') item.name = value;
  else if (field === 'qty') {
    item.qty = parseFloat(value) || 0;
    item.total = +(item.qty * item.rate).toFixed(2);
  } else if (field === 'mrp') {
    item.mrp = parseFloat(value) || 0;
  } else if (field === 'rate') {
    item.rate = parseFloat(value) || 0;
    item.total = +(item.qty * item.rate).toFixed(2);
  } else if (field === 'gst') {
    item.gst = parseInt(value) || 0;
  } else if (field === 'total') {
    item.total = parseFloat(value) || 0;
    if (item.qty > 0) item.rate = +(item.total / item.qty).toFixed(2);
  }

  recalculateDraft(draft);

  // Update dynamic elements on page without re-rendering inputs
  const pfx = kind === 'ocr' ? 'ocr-r' : 'r';
  const totEl = document.getElementById(`${pfx}-total`);
  if (totEl) totEl.textContent = '₹' + draft.grandTotal.toFixed(2);

  const subEl = document.getElementById(`${pfx}-sub`);
  if (subEl) subEl.textContent = `${draft.items.length} items · extracted ₹${draft.computedItemTotal.toFixed(2)}`;

  renderDraftSlabs(kind === 'ocr' ? 'ocr-r-gst' : 'r-gst', draft.slabs);
  renderDraftFlags(kind === 'ocr' ? 'ocr-r-flags' : 'r-flags', draft.flags);

  // Update line item total input directly
  const rowTotInp = document.getElementById(`${kind}-it-tot-${index}`);
  if (rowTotInp && field !== 'total') rowTotInp.value = item.total.toFixed(2);
}

function addDraftItem(kind) {
  const draft = kind === 'ocr' ? _ocrPend : _pend;
  if (!draft) return;
  draft.items.push({ name: 'New Item', qty: 1, mrp: 0, rate: 0, gst: 5, total: 0, taxable: 0, gstAmt: 0, cgst: 0, sgst: 0 });
  recalculateDraft(draft);
  if (kind === 'ocr') showOCRResult(draft);
  else showResult(draft);
}

function deleteDraftItem(kind, index) {
  const draft = kind === 'ocr' ? _ocrPend : _pend;
  if (!draft) return;
  draft.items.splice(index, 1);
  recalculateDraft(draft);
  if (kind === 'ocr') showOCRResult(draft);
  else showResult(draft);
}

function itemEditorRow(item, index, kind) {
  return `<tr>
    <td><input type="text" class="cell-inp" value="${ex(item.name)}" oninput="updateDraftItem('${kind}', ${index}, 'name', this.value)"/></td>
    <td style="width:70px"><input type="number" step="any" class="cell-inp mono" value="${item.qty}" oninput="updateDraftItem('${kind}', ${index}, 'qty', this.value)"/></td>
    <td style="width:85px"><input type="number" step="0.01" class="cell-inp mono" value="${(item.mrp || 0).toFixed(2)}" oninput="updateDraftItem('${kind}', ${index}, 'mrp', this.value)"/></td>
    <td style="width:85px"><input type="number" step="0.01" class="cell-inp mono" value="${(item.rate || 0).toFixed(2)}" oninput="updateDraftItem('${kind}', ${index}, 'rate', this.value)"/></td>
    <td style="width:75px">
      <select class="cell-inp mono" onchange="updateDraftItem('${kind}', ${index}, 'gst', this.value)">
        ${[0, 3, 5, 12, 18, 28].map(g => `<option value="${g}" ${item.gst === g ? 'selected' : ''}>${g}%</option>`).join('')}
      </select>
    </td>
    <td style="width:95px"><input id="${kind}-it-tot-${index}" type="number" step="0.01" class="cell-inp mono fw7" value="${item.total.toFixed(2)}" oninput="updateDraftItem('${kind}', ${index}, 'total', this.value)"/></td>
    <td style="width:36px;text-align:center"><button class="btn-ghost" style="color:var(--re);padding:2px 6px" onclick="deleteDraftItem('${kind}', ${index})" title="Delete item"><i class="fas fa-trash"></i></button></td>
  </tr>`;
}

function renderDraftFlags(targetId, flags) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!flags || !flags.length) { el.innerHTML = ''; return; }
  el.innerHTML = flags.map(f => `
    <div class="note ${f.type === 'error' ? 'note-err' : 'note-warn'}" style="margin-bottom:6px">
      <i class="fas ${f.type === 'error' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}"></i>
      <span>${ex(f.msg)}</span>
    </div>
  `).join('');
}

function renderDraftSlabs(targetId, slabs) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = Object.entries(slabs || {}).sort((a, b) => +a[0] - +b[0]).map(([s, v]) => `
    <div class="gst-row">
      <span class="gb ${GCLS[s] || 'g5'}">GST ${s}%</span>
      <span class="mono">₹${v.taxable.toFixed(2)}</span>
      <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
      <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
      <span class="mono fw7" style="color:${GCOL[s] || 'var(--mu2)'}">₹${v.gstAmt.toFixed(2)}</span>
    </div>
  `).join('');
}

/* ─── DISPLAY RESULT: MODAL ─── */
function showResult(p) {
  _pend = p;
  _ocrPend = p;
  H('m-prog'); H('m-up'); S('m-res');
  document.getElementById('r-sub').textContent = `${p.items.length} items detected`;
  document.getElementById('r-store').textContent = p.store;

  document.getElementById('r-hdr').innerHTML = `
    <div class="ocr-f"><label>Store Name</label><input type="text" class="cell-inp" style="font-weight:600" value="${ex(p.store)}" oninput="_pend.store=this.value;_ocrPend.store=this.value;document.getElementById('r-store').textContent=this.value;"/></div>
    <div class="ocr-f"><label>Bill / Inv No</label><input type="text" class="cell-inp mono" style="font-size:11.5px" value="${ex(p.billNo)}" oninput="_pend.billNo=this.value;_ocrPend.billNo=this.value;"/></div>
    <div class="ocr-f"><label>Date</label><input type="text" class="cell-inp" value="${ex(p.date)}" oninput="_pend.date=this.value;_ocrPend.date=this.value;"/></div>
    <div class="ocr-f"><label>GSTIN</label><input type="text" class="cell-inp mono" style="font-size:11px" value="${ex(p.gstin || '')}" placeholder="Optional GSTIN" oninput="_pend.gstin=this.value.toUpperCase();_ocrPend.gstin=this.value.toUpperCase();"/></div>
    <div class="ocr-f"><label>Source</label><span style="color:var(--bl);font-size:12px;padding:4px 0;display:inline-block"><i class="fas ${p.source === 'paddle_ocr' ? 'fa-camera' : p.source === 'manual_builder' ? 'fa-file-pen' : 'fa-file-pdf'}" style="margin-right:4px"></i>${p.source === 'paddle_ocr' ? 'PaddleOCR' : p.source === 'manual_builder' ? 'Manual Template' : 'Digital PDF'}</span></div>`;

  const tbody = document.getElementById('r-tbody');
  if (p.items.length === 0) {
    tbody.innerHTML = '';
    document.getElementById('r-noitems').style.display = '';
  } else {
    document.getElementById('r-noitems').style.display = 'none';
    tbody.innerHTML = p.items.map((it, i) => itemEditorRow(it, i, 'modal')).join('');
  }

  renderDraftSlabs('r-gst', p.slabs);
  document.getElementById('r-total').textContent = '₹' + p.grandTotal.toFixed(2);
  document.getElementById('r-sub').textContent = `${p.items.length} items · ₹${p.computedItemTotal.toFixed(2)}`;
  renderDraftFlags('r-flags', p.flags);

  toast(`✓ Extracted ${p.items.length} items from ${p.store}`, 'success');
}

/* ─── DISPLAY RESULT: OCR PAGE ─── */
function showOCRResult(p) {
  _ocrPend = p;
  _pend = p;
  document.getElementById('ocr-results').style.display = '';
  document.getElementById('ocr-r-sub').textContent = `${p.items.length} items detected`;
  document.getElementById('ocr-r-store').textContent = p.store;

  document.getElementById('ocr-r-hdr').innerHTML = `
    <div class="ocr-f"><label>Store Name</label><input type="text" class="cell-inp" style="font-weight:600" value="${ex(p.store)}" oninput="_ocrPend.store=this.value;_pend.store=this.value;document.getElementById('ocr-r-store').textContent=this.value;"/></div>
    <div class="ocr-f"><label>Bill / Inv No</label><input type="text" class="cell-inp mono" style="font-size:11.5px" value="${ex(p.billNo)}" oninput="_ocrPend.billNo=this.value;_pend.billNo=this.value;"/></div>
    <div class="ocr-f"><label>Date</label><input type="text" class="cell-inp" value="${ex(p.date)}" oninput="_ocrPend.date=this.value;_pend.date=this.value;"/></div>
    <div class="ocr-f"><label>GSTIN</label><input type="text" class="cell-inp mono" style="font-size:11px" value="${ex(p.gstin || '')}" placeholder="Optional GSTIN" oninput="_ocrPend.gstin=this.value.toUpperCase();_pend.gstin=this.value.toUpperCase();"/></div>
    <div class="ocr-f"><label>Engine</label><span style="color:var(--g);font-size:12px;padding:4px 0;display:inline-block"><i class="fas fa-microchip" style="margin-right:4px"></i>PaddleOCR v3</span></div>`;

  const tbody = document.getElementById('ocr-r-tbody');
  if (p.items.length === 0) {
    tbody.innerHTML = '';
    document.getElementById('ocr-r-noitems').style.display = '';
  } else {
    document.getElementById('ocr-r-noitems').style.display = 'none';
    tbody.innerHTML = p.items.map((it, i) => itemEditorRow(it, i, 'ocr')).join('');
  }

  renderDraftSlabs('ocr-r-gst', p.slabs);
  document.getElementById('ocr-r-total').textContent = '₹' + p.grandTotal.toFixed(2);
  document.getElementById('ocr-r-sub').textContent = `${p.items.length} editable items · extracted ₹${p.computedItemTotal.toFixed(2)}`;
  renderDraftFlags('ocr-r-flags', p.flags);

  toast(`✓ OCR scan complete — ${p.items.length} items from ${p.store}`, 'success');
}

/* ─── SAVE INVOICE (UNIFIED) ─── */
async function saveBill() {
  const raw = _pend || _ocrPend;
  if (!raw) return;
  const b = normalizeBill(raw);
  if (!b) return;

  // Prevent duplicate insertion
  DB.bills = DB.bills.filter(x => String(x.id) !== String(b.id));
  DB.bills.unshift(b);

  await persistInvoice(b);
  _pend = null;
  _ocrPend = null;

  updateSB();
  closeModal();
  renderRecent();
  renderOCRRecent();

  toast(`✓ Saved: ${b.items.length} items · ₹${(Number(b.grandTotal) || 0).toFixed(2)}`, 'success');

  // Immediately navigate to the invoices vault so the user sees their saved bill
  goPage('invoices');
}

function saveOCRBill() {
  saveBill();
}

function resetOCR() {
  _ocrPend = null;
  document.getElementById('ocr-results').style.display = 'none';
  document.getElementById('ocr-processing').style.display = 'none';
  document.getElementById('ocr-preview-wrap').style.display = 'none';
  document.getElementById('ocr-raw-text').style.display = 'none';
}

/* ─── EXPORT: EXCEL (XLSX) ─── */
function dlExcel(billArg) {
  const b = billArg || _pend || _ocrPend || DB.bills[0];
  if (!b) { toast('No bill available to export', 'warn'); return; }
  if (typeof XLSX === 'undefined') { toast('Excel library is loading, please try again', 'warn'); return; }

  const wb = XLSX.utils.book_new();

  // Sheet 1: Items
  const rows = [['Item', 'Qty', 'MRP', 'Rate', 'GST%', 'Taxable Value', 'CGST', 'SGST', 'Total', 'Category / Ledger']];
  b.items.forEach(it => {
    rows.push([it.name, it.qty, +it.mrp.toFixed(2), +it.rate.toFixed(2), it.gst + '%', +it.taxable.toFixed(2), +it.cgst.toFixed(2), +it.sgst.toFixed(2), +it.total.toFixed(2), ledger(it.name)]);
  });
  rows.push([]);
  rows.push(['', '', '', '', '', '', '', '', 'Grand Total', +b.grandTotal.toFixed(2)]);
  rows.push(['', '', '', '', '', '', '', '', 'Total GST', +b.totalGSTAmt.toFixed(2)]);
  const ws1 = XLSX.utils.aoa_to_sheet(rows);
  ws1['!cols'] = [{ wch: 38 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Line Items');

  // Sheet 2: GST Breakdown
  const gstData = [['GST Slab', 'Taxable Value', 'CGST', 'SGST', 'Total GST', 'Input Tax Ledger']];
  Object.entries(b.slabs).sort((a, z) => +a[0] - +z[0]).forEach(([s, v]) => {
    gstData.push(['GST ' + s + '%', +v.taxable.toFixed(2), +(v.gstAmt / 2).toFixed(2), +(v.gstAmt / 2).toFixed(2), +v.gstAmt.toFixed(2), `Input GST @${s}%`]);
  });
  gstData.push(['TOTAL', +b.items.reduce((s, i) => s + i.taxable, 0).toFixed(2), +(b.totalGSTAmt / 2).toFixed(2), +(b.totalGSTAmt / 2).toFixed(2), +b.totalGSTAmt.toFixed(2), '']);
  const ws2 = XLSX.utils.aoa_to_sheet(gstData);
  ws2['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'GST Summary');

  // Sheet 3: Invoice Info
  const info = [
    ['Field', 'Value'],
    ['Vendor / Store', b.store],
    ['Invoice / Bill No', b.billNo],
    ['Date', b.date],
    ['GSTIN', b.gstin || 'Not found'],
    ['Grand Total', '₹' + b.grandTotal.toFixed(2)],
    ['Total GST Amount', '₹' + b.totalGSTAmt.toFixed(2)],
    ['Total Items', b.items.length],
    ['Source', b.source || 'FinBotics']
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(info);
  ws3['!cols'] = [{ wch: 20 }, { wch: 32 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'Invoice Info');

  XLSX.writeFile(wb, `FinBotics_${b.store.replace(/\s+/g, '_')}_${b.billNo}.xlsx`);
  toast('Excel file downloaded', 'success');
}

function dlOCRExcel() { dlExcel(_ocrPend); }

/* ─── EXPORT: CSV ─── */
function dlCSV(billArg) {
  const b = billArg || _pend || _ocrPend || DB.bills[0];
  if (!b) { toast('No bill available to export', 'warn'); return; }

  let csv = 'Store,Bill No,Date,GSTIN,Item,Qty,MRP,Rate,GST%,Taxable,CGST,SGST,Total,Ledger\n';
  b.items.forEach(it => {
    csv += `"${ex(b.store)}","${ex(b.billNo)}","${ex(b.date)}","${ex(b.gstin)}","${ex(it.name)}",${it.qty},${it.mrp.toFixed(2)},${it.rate.toFixed(2)},${it.gst}%,${it.taxable.toFixed(2)},${it.cgst.toFixed(2)},${it.sgst.toFixed(2)},${it.total.toFixed(2)},"${ledger(it.name)}"\n`;
  });
  csv += `\n"Grand Total",,,,,,,,,,,,${b.grandTotal.toFixed(2)}\n`;
  csv += `"Total GST",,,,,,,,,,,,${b.totalGSTAmt.toFixed(2)}\n`;

  dl(csv, `FinBotics_${b.store.replace(/\s+/g, '_')}_${b.billNo}.csv`, 'text/csv');
  toast('CSV downloaded', 'success');
}

function dlOCRCsv() { dlCSV(_ocrPend); }

function exportAll() {
  if (!DB.bills.length) { toast('No invoices scanned yet', 'warn'); return; }
  let csv = 'Store,Bill No,Date,GSTIN,Item,Qty,MRP,Rate,GST%,Taxable,CGST,SGST,Total,Ledger\n';
  DB.bills.forEach(b => {
    b.items.forEach(it => {
      csv += `"${ex(b.store)}","${ex(b.billNo)}","${ex(b.date)}","${ex(b.gstin)}","${ex(it.name)}",${it.qty},${it.mrp.toFixed(2)},${it.rate.toFixed(2)},${it.gst}%,${it.taxable.toFixed(2)},${it.cgst.toFixed(2)},${it.sgst.toFixed(2)},${it.total.toFixed(2)},"${ledger(it.name)}"\n`;
    });
  });
  dl(csv, `FinBotics_AllInvoices.csv`, 'text/csv');
  toast('All invoices exported to CSV', 'success');
}

/* ─── EXPORT: TALLY XML ─── */
function dlTallyXML(billArg) {
  const b = billArg || _pend || _ocrPend || DB.bills[0];
  if (!b) { toast('No bill to export', 'warn'); return; }

  const dt = tallyDt(b.date);
  function xe(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  const itemEntries = b.items.map(it => `
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xe(ledger(it.name))}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${it.taxable.toFixed(2)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`).join('');

  const gstEntries = Object.entries(b.slabs).map(([slab, v]) => `
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>CGST @${slab / 2}%</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${(v.gstAmt / 2).toFixed(2)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>SGST @${slab / 2}%</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${(v.gstAmt / 2).toFixed(2)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`).join('');

  const supplierEntry = `
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xe(b.store)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${b.grandTotal.toFixed(2)}</AMOUNT>
            ${b.gstin ? `<PARTYGSTIN>${xe(b.gstin)}</PARTYGSTIN>` : ''}
          </ALLLEDGERENTRIES.LIST>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- FinBotics Tally Voucher | ${xe(b.store)} | ${xe(b.billNo)} | Total: Rs.${b.grandTotal.toFixed(2)} -->
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${dt}</DATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xe(b.billNo)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${xe(b.store)}</PARTYLEDGERNAME>
            <NARRATION>Purchase from ${xe(b.store)} | Bill: ${xe(b.billNo)} | Imported via FinBotics</NARRATION>
            <ISINVOICE>Yes</ISINVOICE>
            ${itemEntries}
            ${gstEntries}
            ${supplierEntry}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  dl(xml, `Tally_${b.store.replace(/\s+/g, '_')}_${b.billNo}.xml`, 'application/xml');
  toast('Tally XML downloaded! TallyPrime → Import → Vouchers', 'success');
}

/* ─── MANUAL BILL BUILDER TEMPLATES ─── */
const BILL_TEMPLATES = {
  grocery: {
    name: 'Retail Grocery & Supermarket',
    icon: 'fa-basket-shopping',
    desc: 'BigBasket / D-Mart basket with staples, milk, edible oil & tea',
    store: 'BigBasket Wholesale Ltd.',
    billNo: () => 'BB-MUM-' + Math.floor(100000 + Math.random() * 900000),
    gstin: '27AABCB1234A1Z5',
    items: [
      { name: 'Aashirvaad Superior MP Atta 5kg', qty: 1, mrp: 320, rate: 295, gst: 0, total: 295 },
      { name: 'Amul Taaza Toned Milk 1L', qty: 2, mrp: 72, rate: 68, gst: 5, total: 136 },
      { name: 'Fortune Sunlite Refined Sunflower Oil 1L', qty: 1, mrp: 180, rate: 162, gst: 5, total: 162 },
      { name: 'Tata Tea Gold Premium 500g', qty: 1, mrp: 290, rate: 260, gst: 5, total: 260 },
      { name: 'Surf Excel Matic Liquid Detergent 1L', qty: 1, mrp: 245, rate: 215, gst: 18, total: 215 }
    ]
  },
  hardware: {
    name: 'B2B Hardware & Tax Invoice',
    icon: 'fa-trowel-bricks',
    desc: 'Formal tax invoice with steel, fasteners, primer & 18% GST',
    store: 'Surabhi Hardwares, Bangalore',
    billNo: () => 'SHB/' + Math.floor(100 + Math.random() * 900) + '/26',
    gstin: '29AACCT3705E000',
    items: [
      { name: '12MM* TMT Steel Rods (Fe 550D)', qty: 7, mrp: 550, rate: 500, gst: 18, total: 4130 },
      { name: 'M10 High Tensile Bolts & Nuts (Box of 50)', qty: 2, mrp: 450, rate: 410, gst: 18, total: 967.60 },
      { name: 'Berger Zinc Chromate Red Oxide Primer 4L', qty: 1, mrp: 1100, rate: 980, gst: 18, total: 1156.40 }
    ]
  },
  electronics: {
    name: 'Office & IT Equipment',
    icon: 'fa-laptop',
    desc: 'Commercial supplies with peripherals, paper cartons & USB drives',
    store: 'Universal Infotech & Stationery',
    billNo: () => 'UIS-' + Math.floor(1000 + Math.random() * 9000),
    gstin: '27AABCI4433K1Z1',
    items: [
      { name: 'Logitech MK270 Wireless Keyboard & Mouse', qty: 2, mrp: 1795, rate: 1499, gst: 18, total: 3537.64 },
      { name: 'JK Copier A4 Paper Ream 75 GSM (Carton of 5)', qty: 2, mrp: 1450, rate: 1250, gst: 12, total: 2800 },
      { name: 'SanDisk Ultra Dual Drive 64GB USB 3.0', qty: 4, mrp: 650, rate: 540, gst: 18, total: 2548.80 }
    ]
  },
  blank: {
    name: 'Blank Invoice (From Scratch)',
    icon: 'fa-pen-to-square',
    desc: 'Empty canvas to build custom supplier bill with custom items',
    store: 'New Supplier / Vendor',
    billNo: () => 'INV-' + Date.now().toString().slice(-6),
    gstin: '',
    items: [
      { name: 'New Item 1', qty: 1, mrp: 100, rate: 100, gst: 18, total: 100 }
    ]
  }
};

function getBuilderBoxHtml() {
  return `
    <div class="builder-box">
      <div class="builder-box-header">
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:var(--g);font-weight:700;margin-bottom:3px">
            <i class="fas fa-file-pen"></i> FALLBACK BUILDER &amp; TEMPLATES
          </div>
          <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:700;color:var(--tx)">
            Create Bill From Template (Scratch Fallback)
          </div>
          <div style="font-size:12px;color:var(--mu);margin-top:2px;font-weight:300">
            No clear bill photo or digital PDF handy? Pick an Indian commercial template or build from scratch with live GST calculations.
          </div>
        </div>
        <button class="btn btn-primary" onclick="createBillFromTemplate('blank')" style="padding:8px 16px;font-size:12.5px">
          <i class="fas fa-plus"></i> Blank Invoice
        </button>
      </div>
      <div class="builder-grid">
        <div class="builder-card" onclick="createBillFromTemplate('grocery')">
          <div class="builder-card-icon"><i class="fas fa-basket-shopping"></i></div>
          <div class="builder-card-title">Retail Supermarket</div>
          <div class="builder-card-desc">Grocery essentials (Milk, Atta, Oil, Tea) with 0% &amp; 5% GST slabs.</div>
          <div class="builder-card-btn">Load Template <i class="fas fa-arrow-right"></i></div>
        </div>
        <div class="builder-card" onclick="createBillFromTemplate('hardware')">
          <div class="builder-card-icon" style="background:var(--ord);color:var(--or)"><i class="fas fa-trowel-bricks"></i></div>
          <div class="builder-card-title">B2B Hardware &amp; Materials</div>
          <div class="builder-card-desc">Steel rods, primer &amp; fasteners with formal 18% GST and seller GSTIN.</div>
          <div class="builder-card-btn" style="color:var(--or)">Load Template <i class="fas fa-arrow-right"></i></div>
        </div>
        <div class="builder-card" onclick="createBillFromTemplate('electronics')">
          <div class="builder-card-icon" style="background:var(--bld);color:var(--bl)"><i class="fas fa-laptop"></i></div>
          <div class="builder-card-title">Office &amp; IT Equipment</div>
          <div class="builder-card-desc">Peripherals, paper cartons &amp; USB drives with 12% &amp; 18% GST split.</div>
          <div class="builder-card-btn" style="color:var(--bl)">Load Template <i class="fas fa-arrow-right"></i></div>
        </div>
        <div class="builder-card" onclick="createBillFromTemplate('blank')">
          <div class="builder-card-icon" style="background:var(--pud);color:var(--pu)"><i class="fas fa-file-circle-plus"></i></div>
          <div class="builder-card-title">Custom Blank Invoice</div>
          <div class="builder-card-desc">Clean single-line invoice ready to enter custom products, rates &amp; taxes.</div>
          <div class="builder-card-btn" style="color:var(--pu)">Start Scratch <i class="fas fa-arrow-right"></i></div>
        </div>
      </div>
    </div>`;
}

function createBillFromTemplate(key) {
  const tmpl = BILL_TEMPLATES[key] || BILL_TEMPLATES.blank;
  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const draft = {
    id: Date.now(),
    source: 'manual_builder',
    store: tmpl.store,
    billNo: typeof tmpl.billNo === 'function' ? tmpl.billNo() : tmpl.billNo,
    date: today,
    gstin: tmpl.gstin || '',
    items: JSON.parse(JSON.stringify(tmpl.items)),
    flags: []
  };
  const normalized = normalizeDraft(draft, tmpl.name);
  _pend = normalized;
  _ocrPend = normalized;
  openModal();
  showResult(normalized);
  toast(`✓ Template loaded: ${tmpl.name}. You can edit all fields or save immediately.`, 'info');
}

/* ─── RENDER: DASHBOARD ─── */
function renderDash() {
  const has = DB.bills.length > 0;
  const spend = DB.bills.reduce((s, b) => s + (Number(b.grandTotal) || 0), 0);
  const gst = DB.bills.reduce((s, b) => s + (Number(b.totalGSTAmt) || 0), 0);
  const items = DB.bills.reduce((s, b) => s + ((b.items && b.items.length) || 0), 0);
  const flagged = DB.bills.filter(b => (b.flags || []).length > 0);
  const avgBill = DB.bills.length ? (spend / DB.bills.length) : 0;

  // 1. HERO BANNER + 4 MODERN KPI CARDS
  document.getElementById('dash-stats').innerHTML = `
    <!-- Top Editorial Hero -->
    <div class="dash-hero">
      <div style="z-index:2">
        <div class="dash-hero-eyebrow"><span></span> Financial Intelligence · Live Vault</div>
        <div class="dash-hero-amount"><span class="curr">₹</span>${nf(spend)}</div>
        <div class="dash-hero-sub">
          <span class="pill-sub"><i class="fas fa-file-invoice"></i> ${DB.bills.length} Verified Bills</span>
          <span class="pill-sub"><i class="fas fa-chart-line"></i> Avg ₹${nf(avgBill)} / bill</span>
          <span class="pill-sub" style="color:#c9a84c;border-color:rgba(201,168,76,0.3)"><i class="fas fa-shield-halved"></i> 100% Local Neural Engine</span>
        </div>
      </div>
      <div class="dash-hero-mini">
        <div class="dash-hero-stat">
          <div class="dash-hero-stat-val" style="color:#c9a84c">₹${nf(gst)}</div>
          <div class="dash-hero-stat-lbl">Claimable GST</div>
        </div>
        <div class="dash-hero-stat" style="border-left:1px solid rgba(255,255,255,0.12);padding-left:18px">
          <div class="dash-hero-stat-val">${items}</div>
          <div class="dash-hero-stat-lbl">Items Indexed</div>
        </div>
        <div class="dash-hero-stat" style="border-left:1px solid rgba(255,255,255,0.12);padding-left:18px">
          <div class="dash-hero-stat-val" style="color:${flagged.length ? '#ff7043' : '#69f0ae'}">${flagged.length}</div>
          <div class="dash-hero-stat-lbl">${flagged.length ? 'Flags Pending' : 'All Clear'}</div>
        </div>
      </div>
    </div>

    <!-- 4 Interactive KPI Cards -->
    <div class="dash-kpis">
      <div class="dash-kpi-card" onclick="goPage('invoices')">
        <div class="dash-kpi-lbl">Total Turnover <i class="fas fa-arrow-up-right-from-square" style="color:var(--g)"></i></div>
        <div class="dash-kpi-val" style="color:var(--g)">₹${nf(spend)}</div>
        <div class="dash-kpi-context"><i class="fas fa-wallet" style="color:var(--g)"></i> ${DB.bills.length} verified invoice${DB.bills.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="dash-kpi-card" onclick="goPage('analysis')">
        <div class="dash-kpi-lbl">Input Tax Credit <i class="fas fa-percent" style="color:var(--bl)"></i></div>
        <div class="dash-kpi-val" style="color:var(--bl)">₹${nf(gst)}</div>
        <div class="dash-kpi-context"><i class="fas fa-circle-info" style="color:var(--bl)"></i> ${spend > 0 ? (gst / spend * 100).toFixed(1) : 0}% effective recovery</div>
      </div>
      <div class="dash-kpi-card" onclick="goPage('invoices')">
        <div class="dash-kpi-lbl">Line Items Catalog <i class="fas fa-boxes-stacked" style="color:var(--tx)"></i></div>
        <div class="dash-kpi-val">${items}</div>
        <div class="dash-kpi-context"><i class="fas fa-basket-shopping" style="color:var(--mu2)"></i> ${DB.bills.length ? (items / DB.bills.length).toFixed(1) : 0} items per transaction</div>
      </div>
      <div class="dash-kpi-card" onclick="goPage('reconcile')">
        <div class="dash-kpi-lbl">Audit &amp; Compliance <i class="fas fa-triangle-exclamation" style="color:${flagged.length ? 'var(--or)' : 'var(--g)'}"></i></div>
        <div class="dash-kpi-val" style="color:${flagged.length ? 'var(--or)' : 'var(--g)'}">${flagged.length}</div>
        <div class="dash-kpi-context"><i class="fas ${flagged.length ? 'fa-circle-exclamation' : 'fa-circle-check'}" style="color:${flagged.length ? 'var(--or)' : 'var(--g)'}"></i> ${flagged.length ? 'Discrepancies found' : 'Fully compliant ✓'}</div>
      </div>
    </div>`;

  if (!has) {
    document.getElementById('dash-empty').innerHTML = `
      ${getBuilderBoxHtml()}
      <div class="card empty" style="padding:48px 24px;border:2px dashed rgba(30,77,53,0.15)">
        <div class="e-ico"><i class="fas fa-receipt"></i></div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:22px;margin-top:10px">No invoices in vault yet</h3>
        <p style="max-width:360px">Drop a PDF or image in the Bill Scanner, use the live camera, or load a template above to generate your first invoice.</p>
        <button class="btn btn-primary" style="margin-top:16px" onclick="openModal()"><i class="fas fa-plus"></i> Scan First Bill</button>
      </div>`;
    document.getElementById('dash-data').style.display = 'none';
    return;
  }

  document.getElementById('dash-empty').innerHTML = '';
  document.getElementById('dash-data').style.display = '';

  // Store spend breakdown
  const stores = {};
  DB.bills.forEach(b => {
    const stName = b.store || 'Unknown';
    stores[stName] = (stores[stName] || 0) + (Number(b.grandTotal) || 0);
  });
  const sortedStores = Object.entries(stores).sort((a, b) => b[1] - a[1]);
  const maxStore = sortedStores[0] ? sortedStores[0][1] : 1;

  // Category spend
  const cats = {};
  DB.bills.forEach(b => {
    (b.items || []).forEach(it => {
      const c = ledger(it.name);
      cats[c] = (cats[c] || 0) + (Number(it.total) || 0);
    });
  });
  const sortedCats = Object.entries(cats).sort((a, b) => b[1] - a[1]);

  // Recent 4 bills for visual audit stream
  const recentBills = DB.bills.slice(0, 4);

  document.getElementById('dash-data').innerHTML = `
    <!-- Manual Bill Builder & Fallback Templates Box -->
    ${getBuilderBoxHtml()}

    <div class="g2" style="margin-bottom:24px">
      <!-- Store Expenditure Leaderboard -->
      <div class="card">
        <div class="ch">
          <div>
            <div class="ct"><i class="fas fa-store" style="color:var(--g)"></i> Vendor Expenditure Breakdown</div>
            <div class="cs">Top commercial suppliers by total volume</div>
          </div>
          <span style="font-size:11px;font-weight:700;color:var(--mu2);font-family:'JetBrains Mono',monospace">${sortedStores.length} Stores</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${sortedStores.map(([st, amt]) => {
            const pct = (amt / maxStore * 100).toFixed(0);
            return `
            <div class="store-spend-row">
              <div class="store-spend-name" title="${ex(st)}">${ex(st)}</div>
              <div class="store-spend-bar">
                <div class="store-spend-fill" style="width:${pct}%"></div>
              </div>
              <div class="store-spend-amt">₹${nf(amt)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <!-- Category Allocation Matrix -->
      <div class="card">
        <div class="ch">
          <div>
            <div class="ct"><i class="fas fa-layer-group" style="color:var(--bl)"></i> Spending by Category</div>
            <div class="cs">Automated line-item ledger allocation</div>
          </div>
          <span style="font-size:11px;font-weight:700;color:var(--mu2);font-family:'JetBrains Mono',monospace">${sortedCats.length} Categories</span>
        </div>
        <div class="cat-grid">
          ${sortedCats.slice(0, 8).map(([c, amt]) => {
            const pct = spend > 0 ? (amt / spend * 100).toFixed(1) : 0;
            return `
            <div class="cat-card">
              <div class="cat-card-name" title="${c}">${c}</div>
              <div class="cat-card-amt">₹${nf(amt)}</div>
              <div class="cat-card-pct">${pct}% of spend</div>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>

    <!-- Recent Audit Stream / Activity Feed -->
    <div class="card" style="margin-bottom:16px">
      <div class="ch">
        <div>
          <div class="ct"><i class="fas fa-clock-rotate-left" style="color:var(--gold)"></i> Live Audit Stream</div>
          <div class="cs">Latest invoices synchronized with local accounting vault</div>
        </div>
        <button class="btn-ghost" style="padding:4px 10px;font-size:11.5px" onclick="goPage('invoices')">View All Invoices →</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">
        ${recentBills.map(b => {
          const badge = getBillBadge(b.flags);
          const bId = String(b.id || '');
          const grandTotal = (Number(b.grandTotal) || Number(b.computedItemTotal) || 0).toFixed(2);
          const itemCount = (b.items && b.items.length) || 0;
          return `
          <div class="card" style="padding:14px;background:var(--card-bg2);border:1px solid var(--border);cursor:pointer;transition:all .2s" onclick="openDet('${bId}')">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <strong style="font-size:13.5px;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ex(b.store || 'Store')}</strong>
              <span class="badge ${badge.cls}" style="font-size:9.5px;padding:2px 7px"><i class="fas ${badge.icon}"></i> ${badge.text}</span>
            </div>
            <div style="font-size:11px;color:var(--mu2);margin-bottom:10px">${ex(b.date || '')} · ${itemCount} items</div>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="mono fw7" style="font-size:15px;color:var(--g)">₹${grandTotal}</span>
              <span style="font-size:11px;color:var(--bl);font-weight:600">Edit / Inspect →</span>
            </div>
          </div>
        `;
        }).join('')}
      </div>
    </div>`;
}

/* ─── RENDER: INVOICES LIST (EDITORIAL CARD GRID) ─── */
function renderInvoices() {
  const q = (document.getElementById('inv-q')?.value || '').toLowerCase();
  const f = document.getElementById('inv-f')?.value || 'all';

  let list = DB.bills || [];
  if (q) {
    list = list.filter(b => 
      (b.store || '').toLowerCase().includes(q) || 
      (b.billNo || '').toLowerCase().includes(q) || 
      (Array.isArray(b.items) && b.items.some(i => (i.name || '').toLowerCase().includes(q)))
    );
  }
  if (f === 'flag') list = list.filter(b => (b.flags || []).some(fl => fl.type === 'error'));
  if (f === 'warn') list = list.filter(b => (b.flags || []).some(fl => fl.type === 'warn' || fl.code === 'missing_gst') && !(b.flags || []).some(fl => fl.type === 'error'));
  if (f === 'ok')   list = list.filter(b => !(b.flags || []).length);

  const subEl = document.getElementById('inv-sub');
  if (subEl) subEl.textContent = `${list.length} of ${DB.bills.length} invoices indexed`;

  const bodyEl = document.getElementById('inv-body');
  if (!bodyEl) return;

  if (!list.length) {
    bodyEl.innerHTML = `
      <div class="empty" style="padding:50px 10px;text-align:center">
        <div class="e-ico"><i class="fas fa-magnifying-glass"></i></div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:20px;margin-top:10px">No matching invoices</h3>
        <p style="color:var(--mu2);font-size:12.5px">Try adjusting your search criteria or filter options.</p>
      </div>`;
    return;
  }

  bodyEl.innerHTML = `
    <div class="inv-grid">
      ${list.map(b => {
        const badge = getBillBadge(b.flags);
        const srcIcon = b.source === 'paddle_ocr' ? 'fa-camera' : b.source === 'manual_builder' ? 'fa-file-pen' : 'fa-file-pdf';
        const srcLabel = b.source === 'paddle_ocr' ? 'Neural OCR' : b.source === 'manual_builder' ? 'Manual Template' : 'Digital PDF';
        const bId = String(b.id || '');
        const grandTotal = (Number(b.grandTotal) || Number(b.computedItemTotal) || 0).toFixed(2);
        const gstTotal = (Number(b.totalGSTAmt) || 0).toFixed(2);
        const itemCount = Array.isArray(b.items) ? b.items.length : 0;
        return `
        <div class="inv-card ${badge.status === 'flagged' ? 'has-flags' : badge.status === 'warn' ? 'has-warn' : ''}">
          <!-- Top Row: Store & Source -->
          <div class="inv-card-top">
            <div>
              <div class="inv-card-store" title="${ex(b.store || 'Store / Vendor')}">${ex(b.store || 'Store / Vendor')}</div>
              <div class="inv-card-src">
                <i class="fas ${srcIcon}" style="color:var(--g)"></i>
                <span>${srcLabel}</span>
              </div>
            </div>
            ${badge.html}
          </div>

          <!-- Metadata Chips -->
          <div class="inv-card-meta">
            <span class="inv-meta-chip"><i class="fas fa-receipt"></i>${ex(b.billNo || 'N/A')}</span>
            <span class="inv-meta-chip"><i class="fas fa-calendar-day"></i>${ex(b.date || 'N/A')}</span>
            <span class="inv-meta-chip" style="${b.gstin ? 'color:var(--g)' : 'color:var(--re)'}">
              <i class="fas fa-building"></i>${b.gstin ? ex(b.gstin) : 'No GSTIN'}
            </span>
          </div>

          <!-- Tax Snapshot -->
          <div style="font-size:11.5px;color:var(--mu2);margin-bottom:14px;display:flex;justify-content:space-between">
            <span>Input GST: <strong class="mono" style="color:var(--bl)">₹${gstTotal}</strong></span>
            <span>Items: <strong class="mono" style="color:var(--tx)">${itemCount}</strong></span>
          </div>

          <!-- Bottom Row: Grand Total & Quick Actions -->
          <div class="inv-card-foot">
            <div class="inv-card-amount">₹${grandTotal}</div>
            <div class="inv-card-actions">
              <button class="icon-btn" onclick="openDet('${bId}')" title="Inspect Details" style="width:32px;height:32px"><i class="fas fa-eye"></i></button>
              <button class="icon-btn" onclick="dlExcel(DB.bills.find(x => String(x.id) === '${bId}'))" title="Export Excel" style="width:32px;height:32px;color:var(--g)"><i class="fas fa-file-excel"></i></button>
              <button class="icon-btn" onclick="dlTallyXML(DB.bills.find(x => String(x.id) === '${bId}'))" title="Export Tally XML" style="width:32px;height:32px;color:var(--bl)"><i class="fas fa-file-import"></i></button>
              <button class="icon-btn" onclick="delBill('${bId}')" title="Delete Invoice" style="width:32px;height:32px;color:var(--re)"><i class="fas fa-trash"></i></button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ─── RENDER: RECONCILE (AUDIT & DISCREPANCY DESK) ─── */
function renderReconcile() {
  const flagged = DB.bills.filter(b => (b.flags || []).some(f => f.type === 'error'));
  const warnings = DB.bills.filter(b => (b.flags || []).some(f => f.type === 'warn' || f.code === 'missing_gst') && !(b.flags || []).some(f => f.type === 'error'));
  const attentionBills = [...flagged, ...warnings];

  if (!attentionBills.length) {
    document.getElementById('rec-body').innerHTML = `
      <div class="card empty" style="padding:70px 24px;border:2px dashed rgba(30,77,53,0.15)">
        <div class="e-ico" style="background:var(--gd);color:var(--g);width:72px;height:72px;font-size:32px"><i class="fas fa-shield-check"></i></div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:700;margin-top:14px;color:var(--tx)">All Invoices Verified</h3>
        <p style="max-width:420px;font-size:13px;line-height:1.7;color:var(--mu)">Zero reconciliation anomalies detected. All arithmetic calculations, GST percentages, and Rate vs MRP constraints are strictly aligned.</p>
        <button class="btn btn-primary" style="margin-top:16px" onclick="goPage('invoices')"><i class="fas fa-file-invoice"></i> Browse All Invoices</button>
      </div>`;
    return;
  }

  document.getElementById('rec-body').innerHTML = `
    <!-- Desk Header -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.18em;color:var(--or);font-weight:700;margin-bottom:4px"><i class="fas fa-triangle-exclamation"></i> ACTION REQUIRED</div>
        <h2 style="font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:700;color:var(--tx);margin:0">Tax &amp; Pricing Discrepancy Desk</h2>
        <p style="font-size:12.5px;color:var(--mu);margin-top:2px;font-weight:300">${flagged.length} flagged error${flagged.length !== 1 ? 's' : ''} and ${warnings.length} warning${warnings.length !== 1 ? 's' : ''} pending review.</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        ${flagged.length ? `<span class="badge badge-warn" style="font-size:12px;padding:6px 14px"><i class="fas fa-flag"></i> ${flagged.length} Flagged</span>` : ''}
        ${warnings.length ? `<span class="badge badge-amber" style="font-size:12px;padding:6px 14px"><i class="fas fa-triangle-exclamation"></i> ${warnings.length} Warnings</span>` : ''}
      </div>
    </div>

    <!-- Flagged & Warning Cards -->
    <div style="display:flex;flex-direction:column;gap:16px">
      ${attentionBills.map(b => {
        const badge = getBillBadge(b.flags);
        const bId = String(b.id || '');
        const grandTotal = (Number(b.grandTotal) || Number(b.computedItemTotal) || 0).toFixed(2);
        const itemCount = Array.isArray(b.items) ? b.items.length : 0;
        return `
        <div class="flag-card ${badge.status === 'warn' ? 'has-warn' : ''}">
          <div class="flag-card-head">
            <div>
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                <span class="flag-card-title">${ex(b.store || 'Store')}</span>
                ${badge.html}
              </div>
              <div class="flag-card-meta">
                <span class="mono">${ex(b.billNo || 'N/A')}</span> · ${ex(b.date || 'N/A')} · ${itemCount} items
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:16px">
              <div style="text-align:right">
                <div style="font-size:10px;color:var(--mu2);text-transform:uppercase">Grand Total</div>
                <div class="mono fw7" style="font-size:20px;color:var(--g)">₹${grandTotal}</div>
              </div>
              <button class="btn btn-primary" style="padding:7px 14px;font-size:12px" onclick="openDet('${bId}')"><i class="fas fa-screwdriver-wrench"></i> Review &amp; Fix</button>
            </div>
          </div>
          <div>
            ${(b.flags || []).map(fl => {
              const isErr = fl.type === 'error';
              const title = fl.code === 'missing_gst' ? 'Tax Slab Notice: Missing GST Rate'
                : fl.code === 'non_bill_document' ? 'Invalid Document: False Bill Detected'
                : fl.code === 'rate_above_mrp' ? 'Pricing Anomaly: Rate Exceeds MRP'
                : fl.code === 'total_mismatch' ? 'Financial Variance: Total Mismatch'
                : fl.code === 'no_gstin' ? 'Compliance Notice: Missing Vendor GSTIN'
                : 'Validation Alert';
              const icon = isErr ? 'fa-circle-xmark' : 'fa-triangle-exclamation';
              return `
              <div class="flag-item ${isErr ? 'flag-err' : 'flag-warn'}">
                <div class="flag-item-icon"><i class="fas ${icon}"></i></div>
                <div class="flag-item-body">
                  <div class="flag-item-type">${title}</div>
                  <div class="flag-item-desc">${ex(fl.msg)}</div>
                </div>
                <button class="btn-ghost" style="padding:4px 10px;font-size:11px" onclick="openDet('${bId}')">Edit Item</button>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ─── RENDER: ANALYSIS (GST ANALYTICS & SLAB DONUTS) ─── */
function renderAnalysis() {
  const slabs = { 0: 0, 3: 0, 5: 0, 12: 0, 18: 0, 28: 0 };
  const slabTaxable = { 0: 0, 3: 0, 5: 0, 12: 0, 18: 0, 28: 0 };
  let totalTaxable = 0;
  let totalGst = 0;

  DB.bills.forEach(b => {
    Object.entries(b.slabs || {}).forEach(([s, v]) => {
      slabs[s] = (slabs[s] || 0) + v.gstAmt;
      slabTaxable[s] = (slabTaxable[s] || 0) + v.taxable;
      totalTaxable += v.taxable;
      totalGst += v.gstAmt;
    });
  });

  const effectiveRate = totalTaxable > 0 ? (totalGst / totalTaxable * 100).toFixed(2) : '0.00';
  const avgTaxPerBill = DB.bills.length ? (totalGst / DB.bills.length).toFixed(2) : '0.00';

  document.getElementById('ana-body').innerHTML = `
    <!-- Top 3 Financial Performance KPIs -->
    <div class="analysis-kpis">
      <div class="analysis-kpi">
        <div class="analysis-kpi-lbl">Total Taxable Base</div>
        <div class="analysis-kpi-val">₹${nf(totalTaxable)}</div>
        <div class="analysis-kpi-sub"><i class="fas fa-coins" style="color:var(--g)"></i> Net purchasing volume prior to tax computation</div>
      </div>
      <div class="analysis-kpi">
        <div class="analysis-kpi-lbl">Total Input Tax Credit (ITC)</div>
        <div class="analysis-kpi-val" style="color:var(--g)">₹${nf(totalGst)}</div>
        <div class="analysis-kpi-sub"><i class="fas fa-hand-holding-dollar" style="color:var(--g)"></i> Direct tax offset against commercial sales liability</div>
      </div>
      <div class="analysis-kpi">
        <div class="analysis-kpi-lbl">Blended Tax Rate</div>
        <div class="analysis-kpi-val" style="color:var(--bl)">${effectiveRate}%</div>
        <div class="analysis-kpi-sub"><i class="fas fa-receipt" style="color:var(--bl)"></i> Mean ₹${avgTaxPerBill} GST per invoice processed</div>
      </div>
    </div>

    <!-- GST Slabs Visual Donut Rings -->
    <div class="card" style="margin-bottom:24px">
      <div class="ch">
        <div>
          <div class="ct"><i class="fas fa-chart-pie" style="color:var(--g)"></i> GST Slabs Allocation Matrix</div>
          <div class="cs">Relative distribution of Input Tax Credit across statutory Indian GST slabs</div>
        </div>
      </div>
      <div class="donuts-wrap">
        ${[0, 3, 5, 12, 18, 28].map(s => {
          const amt = slabs[s] || 0;
          const tax = slabTaxable[s] || 0;
          const pct = totalGst > 0 ? Math.round((amt / totalGst) * 100) : 0;
          const col = GCOL[s] || '#2d6a4f';
          const conic = `conic-gradient(${col} 0% ${pct}%, var(--card-bg3) ${pct}% 100%)`;
          return `
          <div class="donut-box">
            <div class="donut-ring" style="background:${conic}">
              <div class="donut-hole">
                <span class="donut-pct">${pct}%</span>
                <span class="donut-tag">GST ${s}%</span>
              </div>
            </div>
            <div>
              <span class="gb ${GCLS[s] || 'g5'}">Slab ${s}%</span>
              <div class="donut-amt" style="margin-top:6px">₹${nf(amt)}</div>
              <div style="font-size:10.5px;color:var(--mu2);margin-top:2px">Base ₹${nf(tax)}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Tax Ledgers Detailed Accounting Table -->
    <div class="card">
      <div class="ch">
        <div>
          <div class="ct"><i class="fas fa-table-cells" style="color:var(--bl)"></i> Statutory Tax Audit Ledger</div>
          <div class="cs">Consolidated breakdown for TallyPrime and GSTR-2B filing</div>
        </div>
        <button class="btn btn-outline" onclick="exportAll()"><i class="fas fa-download"></i> Export Audit CSV</button>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>GST Slab</th>
              <th>Applicable Products</th>
              <th>Taxable Base</th>
              <th>CGST (Central)</th>
              <th>SGST (State)</th>
              <th>Total Input GST</th>
            </tr>
          </thead>
          <tbody>
            ${[
              { s: 0, items: 'Atta, Rice, Dal, Milk, Salt, Fresh Veg' },
              { s: 3, items: 'Gold, Silver, Precious Stones' },
              { s: 5, items: 'Packaged Tea, Coffee, Edible Oil, Sugar, Bread' },
              { s: 12, items: 'Processed Foods, Biscuits, Fruit Juice' },
              { s: 18, items: 'Soaps, Toothpaste, Detergents, Personal Care' },
              { s: 28, items: 'Aerated Drinks, Dishwashers, Luxury Items' }
            ].map(({ s, items }) => `
              <tr>
                <td><span class="gb ${GCLS[s] || 'g5'}">GST ${s}%</span></td>
                <td style="color:var(--mu);font-size:12px">${items}</td>
                <td class="mono fw7">₹${(slabTaxable[s] || 0).toFixed(2)}</td>
                <td class="mono" style="color:var(--bl)">₹${((slabs[s] || 0) / 2).toFixed(2)}</td>
                <td class="mono" style="color:var(--bl)">₹${((slabs[s] || 0) / 2).toFixed(2)}</td>
                <td class="mono fw7" style="color:${GCOL[s] || 'var(--g)'}">₹${(slabs[s] || 0).toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ─── BILL DETAIL & LIVE VAULT EDITOR ─── */
let _editPend = null;

function renderSavedSlabsHtml(slabs) {
  return Object.entries(slabs || {}).sort((a, b) => +a[0] - +b[0]).map(([s, v]) => `
    <div class="gst-row">
      <span class="gb ${GCLS[s] || 'g5'}">GST ${s}%</span>
      <span class="mono">₹${v.taxable.toFixed(2)}</span>
      <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
      <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
      <span class="mono fw7" style="color:${GCOL[s] || 'var(--mu2)'}">₹${v.gstAmt.toFixed(2)}</span>
    </div>
  `).join('');
}

function renderSavedFlagsHtml(flags) {
  if (!flags || !flags.length) return '';
  return `
    <div style="margin-bottom:12px">
      ${flags.map(f => `
        <div class="note ${f.type === 'error' ? 'note-err' : 'note-warn'}" style="margin-bottom:5px">
          <i class="fas ${f.type === 'error' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}"></i>
          <span>${ex(f.msg)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderSavedItemsRows(items) {
  if (!items || !items.length) {
    return `<tr><td colspan="7" style="text-align:center;padding:16px;color:var(--mu)">No line items. Click "+ Add Item" above to add products.</td></tr>`;
  }
  return items.map((it, idx) => `
    <tr>
      <td><input type="text" class="cell-inp" value="${ex(it.name)}" oninput="updateSavedItem(${idx}, 'name', this.value)" placeholder="Product description"/></td>
      <td style="width:65px"><input type="number" step="any" class="cell-inp mono" value="${it.qty}" oninput="updateSavedItem(${idx}, 'qty', this.value)"/></td>
      <td style="width:80px"><input type="number" step="0.01" class="cell-inp mono" value="${(it.mrp || 0).toFixed(2)}" oninput="updateSavedItem(${idx}, 'mrp', this.value)"/></td>
      <td style="width:80px"><input type="number" step="0.01" class="cell-inp mono" value="${(it.rate || 0).toFixed(2)}" oninput="updateSavedItem(${idx}, 'rate', this.value)"/></td>
      <td style="width:75px">
        <select class="cell-inp mono" onchange="updateSavedItem(${idx}, 'gst', this.value)">
          ${[0, 3, 5, 12, 18, 28].map(g => `<option value="${g}" ${it.gst === g ? 'selected' : ''}>${g}%</option>`).join('')}
        </select>
      </td>
      <td style="width:95px"><input id="det-it-tot-${idx}" type="number" step="0.01" class="cell-inp mono fw7" value="${it.total.toFixed(2)}" oninput="updateSavedItem(${idx}, 'total', this.value)"/></td>
      <td style="width:36px;text-align:center"><button class="btn-ghost" style="color:var(--re);padding:2px 6px" onclick="deleteSavedBillItem(${idx})" title="Delete item"><i class="fas fa-trash"></i></button></td>
    </tr>
  `).join('');
}

function renderSavedBillEditor() {
  if (!_editPend) return;
  const b = _editPend;
  const bBadge = getBillBadge(b.flags);

  document.getElementById('det-body').innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:12px">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:10px;text-transform:uppercase;letter-spacing:0.14em;color:var(--g);font-weight:700">
            <i class="fas fa-file-invoice"></i> INVOICE RECORD &amp; LIVE AUDIT
          </span>
          <span id="det-flag-badge" class="badge ${bBadge.cls}">
            <i class="fas ${bBadge.icon}"></i> ${bBadge.text}
          </span>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <input type="text" id="det-store" class="cell-inp" style="font-size:18px;font-weight:700;font-family:'Cormorant Garamond',serif;color:var(--tx);padding:4px 8px;border:1px solid var(--border-strong);border-radius:6px;width:100%;max-width:340px" value="${ex(b.store)}" placeholder="Store / Vendor Name" oninput="_editPend.store=this.value" />
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;color:var(--mu2);text-transform:uppercase;letter-spacing:0.08em">Grand Total</div>
        <div id="det-grand-total" class="mono" style="font-size:22px;font-weight:700;color:var(--g)">₹${b.grandTotal.toFixed(2)}</div>
      </div>
    </div>

    <!-- Metadata inputs -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:10px;margin-bottom:14px;background:var(--card-bg2);padding:10px 14px;border-radius:8px;border:1px solid var(--border)">
      <div>
        <label style="font-size:11px;color:var(--mu);display:block;margin-bottom:3px;font-weight:600">Invoice / Bill No.</label>
        <input type="text" id="det-billno" class="cell-inp mono" value="${ex(b.billNo || '')}" placeholder="INV-001" oninput="_editPend.billNo=this.value" />
      </div>
      <div>
        <label style="font-size:11px;color:var(--mu);display:block;margin-bottom:3px;font-weight:600">Invoice Date</label>
        <input type="text" id="det-date" class="cell-inp" value="${ex(b.date || '')}" placeholder="DD-MMM-YYYY" oninput="_editPend.date=this.value" />
      </div>
      <div>
        <label style="font-size:11px;color:var(--mu);display:block;margin-bottom:3px;font-weight:600">GSTIN</label>
        <input type="text" id="det-gstin" class="cell-inp mono" value="${ex(b.gstin || '')}" placeholder="27AAAAA0000A1Z5" oninput="updateSavedGSTIN(this.value)" />
      </div>
      <div>
        <label style="font-size:11px;color:var(--mu);display:block;margin-bottom:3px;font-weight:600">Source</label>
        <div style="padding:6px 0;font-size:12px;color:var(--mu)">
          <i class="fas ${b.source === 'paddle_ocr' ? 'fa-camera' : b.source === 'manual_builder' ? 'fa-file-pen' : 'fa-file-pdf'}" style="margin-right:4px;color:var(--g)"></i>
          ${b.source === 'paddle_ocr' ? 'PaddleOCR' : b.source === 'manual_builder' ? 'Manual Template' : 'Digital PDF'}
        </div>
      </div>
    </div>

    <!-- Audit Flags Container -->
    <div id="det-flags-container">
      ${renderSavedFlagsHtml(b.flags)}
    </div>

    <!-- Items Section -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div style="font-size:12px;font-weight:600;color:var(--tx)">Line Items &amp; Taxable Values</div>
      <button class="btn btn-outline" style="padding:3px 10px;font-size:11px" onclick="addSavedBillItem()">
        <i class="fas fa-plus"></i> Add Item
      </button>
    </div>

    <div class="tbl-wrap" style="max-height:240px;overflow-y:auto;margin-bottom:14px;border:1px solid var(--border);border-radius:8px">
      <table>
        <thead>
          <tr>
            <th>Item Description</th>
            <th style="width:65px">Qty</th>
            <th style="width:80px">MRP</th>
            <th style="width:80px">Rate</th>
            <th style="width:75px">GST %</th>
            <th style="width:95px">Total</th>
            <th style="width:36px"></th>
          </tr>
        </thead>
        <tbody id="det-items-tbody">
          ${renderSavedItemsRows(b.items)}
        </tbody>
      </table>
    </div>

    <!-- GST Breakdown Slabs -->
    <div class="gst-sum" style="margin-bottom:14px">
      <div class="gst-hdr"><span>Slab</span><span>Taxable Base</span><span>CGST</span><span>SGST</span><span>GST Total</span></div>
      <div id="det-gst-breakdown">
        ${renderSavedSlabsHtml(b.slabs)}
      </div>
      <div class="gst-foot">
        <span>Grand Total (Payable)</span>
        <span id="det-foot-total" class="mono" style="font-size:18px;font-weight:700;color:var(--g)">₹${b.grandTotal.toFixed(2)}</span>
      </div>
    </div>

    <!-- Action Toolbar -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding-top:10px;border-top:1px solid var(--border)">
      <button class="btn btn-primary" onclick="saveEditedBill()" style="padding:9px 18px;font-weight:600">
        <i class="fas fa-floppy-disk"></i> Save Changes to Vault
      </button>
      <button class="btn btn-outline" onclick="dlTallyXML(_editPend)"><i class="fas fa-file-import"></i> Tally XML</button>
      <button class="btn btn-outline" onclick="dlExcel(_editPend)"><i class="fas fa-file-excel"></i> Excel</button>
      <button class="btn btn-outline" onclick="dlCSV(_editPend)"><i class="fas fa-download"></i> CSV</button>
      <button class="btn-ghost" style="color:var(--re);margin-left:auto" onclick="delBill(_editPend.id)"><i class="fas fa-trash"></i> Delete</button>
    </div>
  `;
}

function updateSavedItem(index, field, value) {
  if (!_editPend || !_editPend.items[index]) return;
  const it = _editPend.items[index];

  if (field === 'name') it.name = value;
  else if (field === 'qty') {
    it.qty = parseFloat(value) || 0;
    it.total = +(it.qty * it.rate).toFixed(2);
  } else if (field === 'mrp') {
    it.mrp = parseFloat(value) || 0;
  } else if (field === 'rate') {
    it.rate = parseFloat(value) || 0;
    it.total = +(it.qty * it.rate).toFixed(2);
  } else if (field === 'gst') {
    it.gst = parseInt(value) || 0;
  } else if (field === 'total') {
    it.total = parseFloat(value) || 0;
    if (it.qty > 0) it.rate = +(it.total / it.qty).toFixed(2);
  }

  // Recalculate whole invoice
  recalculateDraft(_editPend);

  // Update dynamic fields without destroying user focus
  const rowTotInp = document.getElementById(`det-it-tot-${index}`);
  if (rowTotInp && field !== 'total') rowTotInp.value = it.total.toFixed(2);

  const grandTotEl = document.getElementById('det-grand-total');
  if (grandTotEl) grandTotEl.textContent = '₹' + _editPend.grandTotal.toFixed(2);

  const footTotEl = document.getElementById('det-foot-total');
  if (footTotEl) footTotEl.textContent = '₹' + _editPend.grandTotal.toFixed(2);

  const slabEl = document.getElementById('det-gst-breakdown');
  if (slabEl) slabEl.innerHTML = renderSavedSlabsHtml(_editPend.slabs);

  const flagBadge = document.getElementById('det-flag-badge');
  if (flagBadge) {
    const bBadge = getBillBadge(_editPend.flags);
    flagBadge.className = `badge ${bBadge.cls}`;
    flagBadge.innerHTML = `<i class="fas ${bBadge.icon}"></i> ${bBadge.text}`;
  }

  const flagsCont = document.getElementById('det-flags-container');
  if (flagsCont) flagsCont.innerHTML = renderSavedFlagsHtml(_editPend.flags);
}

function updateSavedGSTIN(val) {
  if (!_editPend) return;
  _editPend.gstin = val.toUpperCase().trim();
  _editPend.flags = (_editPend.flags || []).filter(f => f.code !== 'gstin_format_invalid');
  if (_editPend.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(_editPend.gstin)) {
    _editPend.flags.push({
      type: 'warn',
      code: 'gstin_format_invalid',
      msg: `GSTIN "${_editPend.gstin}" does not match standard 15-character GST format.`
    });
  }
  const flagBadge = document.getElementById('det-flag-badge');
  if (flagBadge) {
    const bBadge = getBillBadge(_editPend.flags);
    flagBadge.className = `badge ${bBadge.cls}`;
    flagBadge.innerHTML = `<i class="fas ${bBadge.icon}"></i> ${bBadge.text}`;
  }
  const flagsCont = document.getElementById('det-flags-container');
  if (flagsCont) flagsCont.innerHTML = renderSavedFlagsHtml(_editPend.flags);
}

function addSavedBillItem() {
  if (!_editPend) return;
  _editPend.items.push({ name: 'New Item', qty: 1, mrp: 0, rate: 0, gst: 5, total: 0, taxable: 0, gstAmt: 0, cgst: 0, sgst: 0 });
  recalculateDraft(_editPend);
  renderSavedBillEditor();
}

function deleteSavedBillItem(index) {
  if (!_editPend) return;
  _editPend.items.splice(index, 1);
  recalculateDraft(_editPend);
  renderSavedBillEditor();
}

async function saveEditedBill() {
  if (!_editPend) return;
  recalculateDraft(_editPend);
  const updated = JSON.parse(JSON.stringify(_editPend));

  const idx = DB.bills.findIndex(x => String(x.id) === String(updated.id));
  if (idx !== -1) {
    DB.bills[idx] = updated;
  } else {
    DB.bills.unshift(updated);
  }

  // Persist to SQLite database via backend API
  await persistInvoice(updated);

  updateSB();
  renderRecent();
  renderOCRRecent();
  const cur = document.querySelector('.sb-link.on')?.dataset.pg;
  if (cur === 'invoices') renderInvoices();
  if (cur === 'dashboard') renderDash();
  if (cur === 'reconcile') renderReconcile();
  if (cur === 'analytics') renderAnalysis();

  closeDet();
  toast(`✓ Saved changes for ${updated.store} (₹${updated.grandTotal.toFixed(2)})`, 'success');
}

function openDet(id) {
  const b = DB.bills.find(x => String(x.id) === String(id));
  if (!b) return;

  _editPend = JSON.parse(JSON.stringify(normalizeBill(b)));
  recalculateDraft(_editPend);
  renderSavedBillEditor();
  document.getElementById('det-modal').classList.add('show');
}

function delBill(id) {
  if (!confirm('Are you sure you want to delete this invoice?')) return;
  DB.bills = DB.bills.filter(x => String(x.id) !== String(id));
  fetch(`/api/invoices/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  closeDet();
  updateSB();
  renderRecent();
  renderOCRRecent();
  const cur = document.querySelector('.sb-link.on')?.dataset.pg;
  if (cur === 'invoices') renderInvoices();
  if (cur === 'dashboard') renderDash();
  if (cur === 'reconcile') renderReconcile();
  toast('Invoice deleted', 'info');
}

/* ─── RECENT SCANS RENDERERS ─── */
function renderRecent() {
  const el = document.getElementById('recent-list');
  if (!el) return;
  const list = DB.bills.slice(0, 5);
  const lbl = document.getElementById('scan-lbl');
  if (lbl) lbl.textContent = `${DB.bills.length} invoices`;

  if (!list.length) {
    el.innerHTML = `
      <div class="empty" style="padding:28px 10px">
        <div class="e-ico"><i class="fas fa-inbox"></i></div>
        <p style="font-size:12px">No invoices scanned yet.</p>
      </div>`;
    return;
  }

  el.innerHTML = list.map(b => {
    const bId = String(b.id || '');
    const grandTotal = (Number(b.grandTotal) || 0).toFixed(2);
    const itemCount = (b.items && b.items.length) || 0;
    return `
    <div class="scan-item" onclick="openDet('${bId}')" style="cursor:pointer">
      <div class="s-ico"><i class="fas ${b.source === 'paddle_ocr' ? 'fa-camera' : 'fa-file-invoice'}"></i></div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ex(b.store || 'Store')}</div>
        <div style="font-size:11px;color:var(--mu)">${ex(b.date || '')} · ${itemCount} items</div>
      </div>
      <div style="text-align:right">
        <div class="mono fw7" style="color:var(--g)">₹${grandTotal}</div>
        ${b.flags && b.flags.length ? '<span class="badge badge-warn" style="font-size:9.5px;padding:1px 6px">Flagged</span>' : ''}
      </div>
    </div>`;
  }).join('');
}

function renderOCRRecent() {
  const el = document.getElementById('ocr-recent-list');
  if (!el) return;
  const list = DB.bills.filter(b => b.source === 'paddle_ocr' || b.source === 'ocr_scan').slice(0, 5);
  const lbl = document.getElementById('ocr-scan-lbl');
  if (lbl) lbl.textContent = `${list.length} scans`;

  if (!list.length) {
    el.innerHTML = `
      <div class="empty" style="padding:28px 10px">
        <div class="e-ico"><i class="fas fa-camera"></i></div>
        <p style="font-size:12px">No OCR scans yet.<br>Upload or capture a bill image to get started.</p>
      </div>`;
    return;
  }

  el.innerHTML = list.map(b => {
    const bId = String(b.id || '');
    const grandTotal = (Number(b.grandTotal) || 0).toFixed(2);
    const itemCount = (b.items && b.items.length) || 0;
    return `
    <div class="scan-item" onclick="openDet('${bId}')" style="cursor:pointer">
      <div class="s-ico" style="background:var(--gd);color:var(--g)"><i class="fas fa-camera"></i></div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ex(b.store || 'Store')}</div>
        <div style="font-size:11px;color:var(--mu)">${ex(b.date || '')} · ${itemCount} items</div>
      </div>
      <div style="text-align:right">
        <div class="mono fw7" style="color:var(--g)">₹${grandTotal}</div>
      </div>
    </div>`;
  }).join('');
}

/* ─── SIDEBAR BADGES ─── */
function updateSB() {
  const sc = document.getElementById('sb-cnt');
  const sf = document.getElementById('sb-flag');
  const f = DB.bills.filter(b => (b.flags || []).length > 0).length;
  if (sc) { sc.style.display = DB.bills.length ? '' : 'none'; sc.textContent = DB.bills.length; }
  if (sf) { sf.style.display = f ? '' : 'none'; sf.textContent = f; }
}

/* ─── SETTINGS & CLEAR DATA ─── */
function clearAll() {
  if (!confirm('Are you sure you want to delete all saved invoices from the database?')) return;
  DB.bills = [];
  fetch('/api/invoices', { method: 'DELETE' }).catch(() => {});
  updateSB();
  renderRecent();
  renderOCRRecent();
  toast('All invoices cleared', 'info');
}

/* ─── TALLY & UTILITY HELPERS ─── */
function ledger(name) {
  const n = (name || '').toLowerCase();
  if (/soap|shampoo|toothpaste|toothbrush|wash|lotion|deo|sanitizer|razor|cotton|wipes|sunscreen/.test(n)) return 'Personal Care';
  if (/detergent|dish|clean|scrub|sponge|vim|rin|surf|harpic|bleach/.test(n)) return 'Household Cleaning';
  if (/milk|curd|yogurt|dahi|ghee|paneer|butter|cream|cheese/.test(n)) return 'Dairy Purchase';
  if (/oil/.test(n)) return 'Cooking Oil Purchase';
  if (/biscuit|cookie|chips|namkeen|chocolate|candy|wafer|snack/.test(n)) return 'Snacks & Confectionery';
  if (/dal|pulse|rajma|chana|moong|toor|masoor|lentil/.test(n)) return 'Pulses Purchase';
  if (/rice|wheat|atta|flour|maida|grain/.test(n)) return 'Staples Purchase';
  if (/tea|coffee|juice|drink|water|soda/.test(n)) return 'Beverages Purchase';
  return 'Grocery Purchase';
}

function tallyDt(d) {
  const M = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const p = String(d || '').split(' ');
  if (p.length === 3) return `${p[2]}${M[p[1].toLowerCase()] || '01'}${p[0].padStart(2, '0')}`;
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function ex(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function setProg(p) { const e = document.getElementById('m-pbar'); if (e) e.style.width = p + '%'; }
function setStages(s) {
  const el = document.getElementById('m-stages');
  if (!el) return;
  el.innerHTML = s.map((x, i) => `
    <div class="stage">
      <div class="sdot ${x.s === 'run' ? 'sr' : x.s === 'done' ? 'sd' : 'sw'}" id="sd${i}">
        ${x.s === 'done' ? '✓' : x.s === 'run' ? '◌' : ''}
      </div>
      <div class="slbl">${x.l}</div>
    </div>`).join('');
}
function sDone(i) { const e = document.getElementById('sd' + i); if (e) { e.className = 'sdot sd'; e.textContent = '✓'; } }
function sRun(i) { const e = document.getElementById('sd' + i); if (e) { e.className = 'sdot sr'; e.textContent = '◌'; } }
function S(id) { const e = document.getElementById(id); if (e) e.style.display = ''; }
function H(id) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
function sl(ms) { return new Promise(r => setTimeout(r, ms)); }
function nf(n) { return Math.round(n).toLocaleString('en-IN'); }
function dl(content, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
}

function toast(msg, type = 'info') {
  const tc = document.getElementById('toasts');
  if (!tc) return;
  const d = document.createElement('div');
  d.className = `toast toast-${type}`;
  d.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check' : type === 'error' ? 'fa-xmark' : type === 'warn' ? 'fa-exclamation' : 'fa-info'}"></i> <span>${ex(msg)}</span>`;
  tc.appendChild(d);
  setTimeout(() => d.remove(), 3500);
}

/* ─── CLIENT FALLBACK PARSER ─── */
function detectStoreClient(tl, fl) {
  if (tl.includes('bigbasket') || fl.includes('bigbasket')) return 'BigBasket';
  if (tl.includes('d-mart') || tl.includes('dmart') || tl.includes('avenue supermarts')) return 'D-Mart';
  if (tl.includes('blinkit') || tl.includes('grofers')) return 'Blinkit';
  if (tl.includes('zepto')) return 'Zepto';
  if (tl.includes('reliance')) return 'Reliance Smart';
  if (tl.includes('swiggy')) return 'Swiggy Instamart';
  if (tl.includes('more')) return 'More Supermarket';
  if (tl.includes('star bazaar')) return 'Star Bazaar';
  return 'Store / Vendor';
}

function parseGroceryClient(text, fname) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const store = detectStoreClient(text.toLowerCase(), (fname || '').toLowerCase());
  const bn = text.match(/(?:bill|invoice|receipt)\s*(?:no\.?|#)\s*[:#-]?\s*([A-Za-z0-9/-]{2,25})/i);
  const billNo = bn ? bn[1].toUpperCase() : `BILL-${Date.now().toString().slice(-6)}`;
  const dateM = text.match(/\b(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);
  const date = dateM ? dateM[1] : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const gstinM = text.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/);
  const gstin = gstinM ? gstinM[1].toUpperCase() : '';

  const items = [];
  lines.forEach(l => {
    const m = l.match(/^(.{2,50}?)\s+(\d{1,3}(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)$/);
    if (m && !/total|subtotal|gstin/i.test(l)) {
      const q = parseFloat(m[2]);
      const rate = parseFloat(m[3].replace(/,/g, ''));
      const amt = parseFloat(m[4].replace(/,/g, ''));
      items.push({ name: m[1].trim(), qty: q, mrp: rate, rate, gst: 5, total: amt });
    }
  });

  return { store, billNo, date, gstin, items, flags: [], grandTotal: 0, totalGSTAmt: 0, slabs: {} };
}

/* ─── DEMO BILLS ─── */
const DEMOS = {
  bigbasket: {
    store: 'BigBasket', billNo: 'BB-20261109-7823', date: '09 Nov 2026', gstin: '27AAACB1234F1ZK',
    items: [
      { name: 'Tata Salt 1kg', qty: 2, mrp: 28, rate: 25, gst: 0, total: 50 },
      { name: 'Amul Taaza Milk 1L', qty: 4, mrp: 72, rate: 68, gst: 5, total: 272 },
      { name: 'Fortune Sunlite Sunflower Oil 1L', qty: 2, mrp: 180, rate: 162, gst: 5, total: 324 },
      { name: 'Aashirvaad Select Atta 5kg', qty: 1, mrp: 345, rate: 310, gst: 0, total: 310 },
      { name: 'Surf Excel Matic Liquid 1L', qty: 1, mrp: 260, rate: 220, gst: 18, total: 220 }
    ]
  },
  dmart: {
    store: 'D-Mart', billNo: 'DM-MUM-2026-4412', date: '11 Nov 2026', gstin: '27AABCA5566K1ZN',
    items: [
      { name: 'Basmati Rice Premium 5kg', qty: 1, mrp: 550, rate: 460, gst: 0, total: 460 },
      { name: 'D-Mart Toor Dal 2kg', qty: 1, mrp: 340, rate: 295, gst: 0, total: 295 },
      { name: 'Dove Cream Beauty Bar 4x100g', qty: 2, mrp: 280, rate: 240, gst: 18, total: 480 },
      { name: 'Parle-G Gold 1kg', qty: 2, mrp: 130, rate: 110, gst: 12, total: 220 }
    ]
  },
  blinkit: {
    store: 'Blinkit', billNo: 'BK-DEL-984321', date: '14 Nov 2026', gstin: '07AAGCB9988D1ZP',
    items: [
      { name: 'Epigamia Greek Yogurt 90g', qty: 3, mrp: 60, rate: 55, gst: 5, total: 165 },
      { name: 'Brown Bread 400g', qty: 1, mrp: 55, rate: 50, gst: 5, total: 50 },
      { name: 'Coca-Cola Zero Sugar 300ml Can', qty: 4, mrp: 40, rate: 40, gst: 28, total: 160 }
    ]
  },
  zepto: {
    store: 'Zepto', billNo: 'ZP-BLR-554109', date: '15 Nov 2026', gstin: '29AAFCZ1122E1Z4',
    items: [
      { name: 'Country Delight Cow Milk 500ml', qty: 2, mrp: 40, rate: 38, gst: 5, total: 76 },
      { name: 'Colgate Total Toothpaste 150g', qty: 1, mrp: 160, rate: 145, gst: 18, total: 145 },
      { name: 'Lays India Magic Masala 50g', qty: 3, mrp: 20, rate: 20, gst: 12, total: 60 }
    ]
  }
};

async function loadDemo(key) {
  const d = DEMOS[key];
  if (!d) return;
  openModal(); S('m-prog'); H('m-up'); H('m-res');
  document.getElementById('m-fname').textContent = d.store + ' — Demo Bill';
  setStages([{ l: 'Loading sample invoice', s: 'run' }, { l: 'Simulating extraction', s: 'wait' }, { l: 'Detecting line items', s: 'wait' }, { l: 'Computing GST breakdown', s: 'wait' }]);
  setProg(20); await sl(200); setProg(50); sDone(0); sRun(1);
  await sl(200); setProg(75); sDone(1); sRun(2);
  await sl(200); setProg(100); sDone(2); sDone(3); await sl(150);

  const parsed = normalizeDraft({ ...d, printedTotal: d.items.reduce((s, i) => s + i.total, 0) }, key);
  showResult(parsed);
}

/* ─── FINBOT ASSISTANT: ON-DEVICE AI ENGINE ─── */
let chatOpen = false;
let _finbotOnline = false;

function toggleChat() {
  const container = document.getElementById('fin-chat');
  const icon = document.getElementById('chat-icon');
  chatOpen = !chatOpen;
  if (chatOpen) {
    container?.classList.remove('closed');
    if (icon) icon.className = 'fas fa-chevron-down';
    checkFinBotStatus();
    setTimeout(() => document.getElementById('chat-in')?.focus(), 250);
  } else {
    container?.classList.add('closed');
    if (icon) icon.className = 'fas fa-chevron-up';
  }
}

async function checkFinBotStatus() {
  const label = document.getElementById('finbot-model-label');
  const dot = document.getElementById('finbot-dot');
  const badge = document.getElementById('finbot-badge-tag');

  try {
    const res = await fetch('/api/chat/status');
    const data = await res.json();
    if (data.online) {
      _finbotOnline = true;
      if (label) label.textContent = 'Private & On-Device';
      if (dot) dot.className = 'bot-online-dot';
      if (badge) badge.textContent = 'On-Device AI';
    } else {
      _finbotOnline = false;
      if (label) label.textContent = 'Offline Rules Mode';
      if (dot) dot.className = 'bot-online-dot offline';
      if (badge) badge.textContent = 'Rules Engine';
    }
  } catch (err) {
    _finbotOnline = false;
    if (label) label.textContent = 'Private & On-Device';
    if (dot) dot.className = 'bot-online-dot offline';
  }
}

function formatMarkdownChat(text) {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bold & Italic
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--card-bg3);padding:1px 5px;border-radius:4px;font-family:JetBrains Mono,monospace;font-size:11px;color:var(--g)">$1</code>');

  // Headers
  html = html.replace(/^### (.*$)/gim, '<div style="font-weight:700;font-size:13px;margin:8px 0 3px;color:var(--tx)">$1</div>');
  html = html.replace(/^## (.*$)/gim, '<div style="font-weight:700;font-size:14px;margin:10px 0 4px;color:var(--tx)">$1</div>');

  // Bullet items
  html = html.replace(/^\s*[-*]\s+(.*)$/gim, '<div style="display:flex;align-items:flex-start;gap:6px;margin:3px 0"><span style="color:var(--g);font-weight:700">•</span><span>$1</span></div>');

  // Numbered list items
  html = html.replace(/^\s*([0-9]+)\.\s+(.*)$/gim, '<div style="display:flex;align-items:flex-start;gap:6px;margin:3px 0"><span style="color:var(--g);font-weight:700">$1.</span><span>$2</span></div>');

  // Paragraph spacing
  html = html.replace(/\n\n+/g, '<div style="height:6px"></div>');
  html = html.replace(/\n/g, '<br>');

  return html;
}

function appendMsg(text, sender, meta) {
  const body = document.getElementById('chat-body');
  if (!body) return;
  const div = document.createElement('div');
  div.className = `msg ${sender}`;

  let contentHtml = formatMarkdownChat(text);
  if (!contentHtml.startsWith('<p>') && !contentHtml.startsWith('<div')) {
    contentHtml = '<p>' + contentHtml + '</p>';
  }

  if (sender === 'bot') {
    const metaText = meta || 'FinBot · 100% On-Device Privacy';
    contentHtml += `<div class="bot-meta"><i class="fas fa-shield-halved"></i> ${metaText}</div>`;
  }

  div.innerHTML = contentHtml;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

function showTyping() {
  const body = document.getElementById('chat-body');
  if (!body) return;
  const div = document.createElement('div');
  div.className = 'typing'; div.id = 'chat-typing';
  div.innerHTML = '<span></span><span></span><span></span>';
  body.appendChild(div); body.scrollTop = body.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

function sendQuickPrompt(query) {
  const inp = document.getElementById('chat-in');
  if (inp) inp.value = query;
  if (!chatOpen) toggleChat();
  askFinBot(query);
}

async function askFinBot(overrideQuery) {
  const inp = document.getElementById('chat-in');
  const query = (overrideQuery || inp?.value || '').trim();
  if (!query) return;
  if (inp) inp.value = '';

  appendMsg(query, 'user');
  showTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        bills: DB.bills
      })
    });

    const data = await res.json().catch(() => ({}));
    hideTyping();

    if (data && data.reply) {
      appendMsg(data.reply, 'bot', '100% On-Device Privacy');
      return;
    }

    throw new Error(data.detail || 'Failed to generate response');
  } catch (err) {
    hideTyping();
    console.warn('FinBot API error:', err);

    // Fallback accountant response
    const spend = DB.bills.reduce((s, b) => s + b.grandTotal, 0);
    const gst = DB.bills.reduce((s, b) => s + b.totalGSTAmt, 0);
    const flagged = DB.bills.filter(b => (b.flags || []).some(f => f.type === 'error'));
    const warnings = DB.bills.filter(b => (b.flags || []).some(f => f.type === 'warn'));

    let fallbackReply = `I analyzed your **${DB.bills.length}** invoices. Total spend is **₹${nf(spend)}** with **₹${nf(gst)}** input GST claimable.`;
    if (flagged.length > 0) {
      fallbackReply += ` You also have **${flagged.length}** flagged bills needing review.`;
    }
    if (warnings.length > 0) {
      fallbackReply += ` (${warnings.length} warning notices).`;
    }

    appendMsg(fallbackReply, 'bot', 'On-Device Financial Ledger');
  }
}

/* ─── INITIALIZATION ON PAGE LOAD ─── */
window.addEventListener('DOMContentLoaded', () => {
  const chatDOM = document.getElementById('fin-chat');
  if (chatDOM) chatDOM.classList.add('closed');
  loadInvoices();
  checkFinBotStatus();
});
