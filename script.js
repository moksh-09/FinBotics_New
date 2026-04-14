pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ─── STATE ─── */
const DB = { bills: [] };
let _pend = null;

/* ─── NAV ─── */
const PG = {
  scanner: ['Bill Scanner', 'Upload a grocery PDF to get started'],
  ocr: ['OCR Scanner', 'Upload or capture a bill image — extract items via OCR'],
  dashboard: ['Dashboard', 'Live stats from your scanned bills'],
  invoices: ['All Invoices', 'Complete record of every scanned bill'],
  reconcile: ['Reconcile', 'Flagged bills needing review'],
  analysis: ['Analysis', 'GST breakdown and spend by category'],
  settings: ['Settings', 'Preferences and info'],
};
document.querySelectorAll('.sb-link[data-pg]').forEach(el => el.addEventListener('click', () => goPage(el.dataset.pg)));

/* — Mobile sidebar toggle — */
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sb-overlay');
  if (sb.classList.contains('open')) {
    sb.classList.remove('open');
    ov.classList.remove('show');
  } else {
    sb.classList.add('open');
    ov.classList.add('show');
  }
}

function goPage(pg) {
  document.querySelectorAll('.sb-link[data-pg]').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.page').forEach(x => x.classList.remove('on'));
  document.querySelector(`.sb-link[data-pg="${pg}"]`)?.classList.add('on');
  document.getElementById(`pg-${pg}`)?.classList.add('on');
  const m = PG[pg] || [pg, ''];
  document.getElementById('pg-title').textContent = m[0];
  document.getElementById('pg-sub').textContent = m[1];
  if (pg === 'dashboard') renderDash();
  if (pg === 'invoices') renderInvoices();
  if (pg === 'reconcile') renderReconcile();
  if (pg === 'analysis') renderAnalysis();
  if (pg === 'ocr') renderOCRRecent();
  // Close sidebar on mobile after navigation
  if (window.innerWidth <= 768) {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sb-overlay');
    if (sb) sb.classList.remove('open');
    if (ov) ov.classList.remove('show');
  }
}

/* ─── FILE ─── */
function triggerFile() { document.getElementById('file-in').click(); }
function handleFile(inp) {
  const f = inp.files[0]; inp.value = '';
  if (!f) return;
  if (f.type !== 'application/pdf') { toast('Only PDF files please', 'warn'); return; }
  processPDF(f.name, f);
}

/* ─── DRAG DROP ─── */
['dragover', 'dragleave', 'drop'].forEach(ev => {
  ['dz', 'm-dz'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'dragover') el.classList.add('drag');
      else if (ev === 'dragleave') el.classList.remove('drag');
      else {
        el.classList.remove('drag');
        const f = e.dataTransfer.files[0];
        if (f && f.type === 'application/pdf') { openModal(); processPDF(f.name, f); }
        else toast('Drop a PDF file', 'warn');
      }
    });
  });
});

/* ─── MODAL ─── */
function openModal() { document.getElementById('scan-modal').classList.add('show'); resetModal(); }
function closeModal() { document.getElementById('scan-modal').classList.remove('show'); }
function closeDet() { document.getElementById('det-modal').classList.remove('show'); }
function resetModal() { S('m-up'); H('m-prog'); H('m-res'); }
document.getElementById('scan-modal').addEventListener('click', e => { if (e.target === document.getElementById('scan-modal')) closeModal(); });
document.getElementById('det-modal').addEventListener('click', e => { if (e.target === document.getElementById('det-modal')) closeDet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeDet(); } });

/* ─── PDF PROCESSING ─── */
async function processPDF(name, file) {
  openModal(); S('m-prog'); H('m-up'); H('m-res');
  document.getElementById('m-fname').textContent = name;
  setProg(0);
  setStages([
    { l: 'Reading PDF pages', s: 'run' },
    { l: 'Extracting text', s: 'wait' },
    { l: 'Detecting items', s: 'wait' },
    { l: 'Calculating GST', s: 'wait' },
  ]);
  try {
    const buf = await file.arrayBuffer();
    setProg(15);
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    setProg(30); sDone(0); sRun(1);

    let txt = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const ct = await pg.getTextContent();
      // Group items by Y coordinate (same line = same Y within 3px tolerance)
      const yMap = {};
      ct.items.forEach(item => {
        // Normalize broken currency/symbol encodings (■, □ used as ₹ in some PDFs)
        let s = item.str.replace(/[■□▪▫●◆◇★☆]/g, '').replace(/Rs\.?\s*/gi, '').replace(/₹\s*/g, '').trim();
        if (!s) return;
        const y = Math.round(item.transform[5] / 3) * 3;
        if (!yMap[y]) yMap[y] = [];
        yMap[y].push({ x: item.transform[4], s });
      });
      // Sort lines top-to-bottom, tokens left-to-right
      Object.keys(yMap).sort((a, b) => +b - +a).forEach(y => {
        const line = yMap[y].sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim();
        if (line) txt += line + '\n';
      });
    }
    setProg(55); sDone(1); sRun(2);

    const parsed = parseGrocery(txt, name);
    setProg(80); sDone(2); sRun(3);
    await sl(300);
    setProg(100); sDone(3);
    await sl(200);
    showResult(parsed);
  } catch (err) {
    console.error(err);
    toast('Could not read PDF. Use a text-based PDF from app/email.', 'error');
    resetModal();
  }
}

/* ─── PARSER ─── */
function parseGrocery(text, fname) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const tl = text.toLowerCase();

  const store = detectStore(tl, fname.toLowerCase());

  // Bill number
  let billNo = 'BILL-' + Date.now().toString().slice(-6);
  const bn = text.match(/(?:bill\s*(?:no|#|number|id)[:\s]*|invoice\s*(?:no|#|number)[:\s]*|order\s*(?:id|no|#)[:\s]*|receipt\s*(?:no|#)[:\s]*)([A-Z0-9][A-Z0-9\-\/]{2,20})/i);
  if (bn) billNo = bn[1].toUpperCase();

  // Date
  let date = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const dm = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (dm) {
    const [, d, m, y] = dm;
    const yr = y.length === 2 ? '20' + y : y;
    const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mi = parseInt(m) - 1;
    date = `${d.padStart(2, '0')} ${MN[mi] || m} ${yr}`;
  }

  // GSTIN — Multi-tier detection for OCR resilience
  let gstin = '';
  
  // Tier 1: Strict match with GSTIN label
  const gm1 = text.match(/GSTIN?\s*[:\s]*([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])/i);
  if (gm1) { gstin = gm1[1].toUpperCase(); }
  
  // Tier 2: Match anywhere without label (standard GSTIN pattern)
  if (!gstin) {
    const gm2 = text.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/);
    if (gm2) gstin = gm2[1].toUpperCase();
  }
  
  // Tier 3: Fuzzy match — OCR may misread digits as letters
  if (!gstin) {
    const gm3 = text.match(/\b([0-9OoIl]{2}[A-Za-z]{5}[0-9OoIl]{4}[A-Za-z][0-9A-Za-zOoIl]Z[0-9A-Za-z])\b/i);
    if (gm3) {
      let g = gm3[1].toUpperCase();
      // Fix OCR errors: positions 0-1 and 7-10 should be digits
      let chars = g.split('');
      [0,1,7,8,9,10].forEach(i => {
        if (chars[i] === 'O') chars[i] = '0';
        if (chars[i] === 'I' || chars[i] === 'L') chars[i] = '1';
        if (chars[i] === 'S') chars[i] = '5';
        if (chars[i] === 'B') chars[i] = '8';
      });
      gstin = chars.join('');
    }
  }
  
  // Tier 4: Line-by-line brute force — find any 15-char alphanumeric block
  if (!gstin) {
    for (const line of lines) {
      // Look for 15 consecutive alphanumeric chars that could be GSTIN
      const matches = line.match(/[0-9A-Za-z]{15}/g);
      if (matches) {
        for (const m of matches) {
          // Validate: first 2 chars should be digits (state code), has Z at position 13
          const upper = m.toUpperCase();
          if (/^[0-9OIL]{2}[A-Z]{5}[0-9OIL]{4}[A-Z].Z./.test(upper)) {
            let chars = upper.split('');
            [0,1,7,8,9,10].forEach(i => {
              if (chars[i] === 'O') chars[i] = '0';
              if (chars[i] === 'I' || chars[i] === 'L') chars[i] = '1';
            });
            gstin = chars.join('');
            break;
          }
        }
      }
      if (gstin) break;
    }
  }
  
  // Tier 5: Strip spaces and search — Tesseract often inserts spaces into GSTIN
  if (!gstin) {
    for (const line of lines) {
      const stripped = line.replace(/\s/g, '').toUpperCase();
      // Look for GSTIN label + value
      const gstinIdx = stripped.indexOf('GSTIN');
      if (gstinIdx >= 0) {
        const after = stripped.substring(gstinIdx + 5).replace(/^[:\s]+/, '');
        const m = after.match(/^([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])/);
        if (m) { gstin = m[1]; break; }
      }
      // Also try without label
      const m2 = stripped.match(/([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])/);
      if (m2) { gstin = m2[1]; break; }
    }
  }
  const items = extractItems(lines);

  // Compute per-item GST
  items.forEach(it => {
    const amt = it.total;
    const tax = amt / (1 + it.gst / 100);
    const ga = amt - tax;
    it.taxable = tax; it.cgst = ga / 2; it.sgst = ga / 2; it.gstAmt = ga;
  });

  const grandTotal = items.reduce((s, i) => s + i.total, 0);
  const totalGSTAmt = items.reduce((s, i) => s + i.gstAmt, 0);

  // Slab totals
  const slabs = {};
  items.forEach(it => {
    if (!slabs[it.gst]) slabs[it.gst] = { taxable: 0, gstAmt: 0, total: 0 };
    slabs[it.gst].taxable += it.taxable;
    slabs[it.gst].gstAmt += it.gstAmt;
    slabs[it.gst].total += it.total;
  });

  const flags = [];
  if (!gstin) flags.push({ type: 'warn', msg: 'No GSTIN on bill — input credit cannot be claimed' });
  if (items.length === 0) flags.push({ type: 'error', msg: 'No line items parsed (may be image PDF)' });

  return { store, billNo, date, gstin, items, flags, grandTotal, totalGSTAmt, slabs, id: Date.now() };
}

function detectStore(tl, fl) {
  if (tl.includes('bigbasket') || fl.includes('bigbasket') || fl.includes('bb')) return 'BigBasket';
  if (tl.includes('d-mart') || tl.includes('dmart') || tl.includes('avenue supermarts') || fl.includes('dmart')) return 'D-Mart';
  if (tl.includes('blinkit') || tl.includes('grofers') || fl.includes('blinkit')) return 'Blinkit';
  if (tl.includes('reliance smart') || tl.includes('jiomart') || fl.includes('reliance')) return 'Reliance Smart';
  if (tl.includes('zepto') || fl.includes('zepto')) return 'Zepto';
  if (tl.includes('swiggy instamart') || fl.includes('instamart')) return 'Swiggy Instamart';
  if (tl.includes('more supermarket') || tl.includes('more retail') || fl.includes('more')) return 'More Supermarket';
  if (tl.includes('star bazaar')) return 'Star Bazaar';
  return 'Grocery Store';
}

/* ─── ITEM EXTRACTION: MULTI-STRATEGY ENGINE ─── */
const SKIP = /^(item\s*name|item|desc|particular|product|sl\.?\s*no|s\.?no|qty|quantity|rate|price|amount|total|subtotal|sub\s*total|grand|gst|cgst|sgst|igst|discount|mrp|tax|net|bill|invoice|date|address|gstin|pan|thank|save|cash|upi|card|paid|balance|change|mode|payment|customer|phone|mob|email|www|tel|fax|cin|hsn|sac|voucher|barcode|weight|unit)/i;

const SKIP_LINE = /^[\-\*\=\|\.\_ \s#@₹Rs\.]+$|^(subtotal|sub total|total|grand total|total gst|total amount|thank you|mode of|payment|customer|address)/i;

function isSkip(l) {
  if (!l || l.length < 3) return true;
  const trimmed = l.trim();
  if (SKIP_LINE.test(trimmed)) return true;
  const w = trimmed.split(/\s+/)[0];
  return SKIP.test(w);
}

function extractItems(lines) {
  const items = [];
  const seen = new Set();

  const add = (name, qty, mrp, rate, gst, total) => {
    name = name.replace(/^\d+[\.\/\)]\s*/, '').trim();
    name = name.replace(/\s+/g, ' '); // Normalize spaces
    if (!name || name.length < 2 || isSkip(name)) return;
    if (!/[a-zA-Z]/.test(name)) return;
    const key = name.toLowerCase().slice(0, 16) + '|' + total.toFixed(0);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ name, qty, mrp, rate, gst, total });
  };

  // ============================================================
  // STRATEGY A (PRIMARY): Universal multi-number line parser
  // Works for ANY tabular bill by extracting ALL numbers from 
  // each line, then using the LAST number as Amount.
  // This handles: Name Qty MRP Rate GST% Amount (6 cols)
  //               Name Qty MRP Rate Amount       (5 cols)
  //               Name Qty Rate Amount            (4 cols)
  //               Name Qty Amount                 (3 cols)
  // ============================================================
  for (const line of lines) {
    if (isSkip(line)) continue;
    
    // Split line into text prefix and number suffix
    // Find where the numbers start: look for the first number that's preceded by whitespace
    const trimmed = line.trim();
    
    // Extract all numbers from the line (including decimals)
    const numberPattern = /[\d,]+(?:\.\d{1,2})?/g;
    const allNumbers = [];
    let lastIdx = 0;
    let match;
    while ((match = numberPattern.exec(trimmed)) !== null) {
      allNumbers.push({ val: parseFloat(match[0].replace(/,/g, '')), idx: match.index, raw: match[0] });
      lastIdx = match.index + match[0].length;
    }
    
    if (allNumbers.length < 2) continue; // Need at least qty + amount
    
    // Find the item name: text before the first number, but only if it contains letters
    let nameEnd = allNumbers[0].idx;
    let name = trimmed.substring(0, nameEnd).trim();
    
    // If the first "number" is actually part of the name (e.g., "Rock Salt 1kg"),
    // check if it's followed immediately by letters (no space) — then it's part of name
    if (allNumbers.length >= 3 && /\d+[a-zA-Z]/.test(trimmed.substring(allNumbers[0].idx, allNumbers[0].idx + allNumbers[0].raw.length + 3))) {
      // First number is part of the name (like "1kg", "500g", "200ml")
      nameEnd = allNumbers[1].idx;
      name = trimmed.substring(0, nameEnd).trim();
      allNumbers.shift(); // Remove this number from consideration
    }
    
    if (!name || name.length < 2 || !/[a-zA-Z]{2}/.test(name)) continue;
    if (isSkip(name)) continue;

    const nums = allNumbers.map(n => n.val).filter(n => !isNaN(n) && n >= 0);
    if (nums.length < 2) continue;

    // The LAST number is always the Amount (total for that item)
    const amount = nums[nums.length - 1];
    if (amount <= 0 || amount > 500000) continue;
    
    // Detect GST% if present: look for a number followed by % in the original line
    let gstPct = -1;
    const gstMatch = trimmed.match(/(\d{1,2})\s*%/);
    if (gstMatch) gstPct = parseInt(gstMatch[1]);
    
    // First small number (<=9999) is likely the Qty
    let qty = 1;
    for (let i = 0; i < nums.length - 1; i++) {
      if (nums[i] > 0 && nums[i] <= 500 && nums[i] === Math.floor(nums[i]) || nums[i] < 10) {
        qty = nums[i];
        break;
      }
    }
    if (qty <= 0) qty = 1;
    
    // Rate: if we have MRP and Rate columns, rate is usually the second-to-last number
    // (before GST% if present, otherwise before Amount)
    let rate = amount / qty;
    if (nums.length >= 3) {
      // Second-to-last number (skipping GST% which would be small like 5, 12, 18, 28)
      const rateIdx = nums.length - 2;
      const candidateRate = nums[rateIdx];
      // Check if this could be a GST percentage (0, 5, 12, 18, 28)
      if ([0, 5, 12, 18, 28].includes(candidateRate) && nums.length >= 4) {
        rate = nums[rateIdx - 1]; // Skip the GST%, use the one before it as rate
      } else if (candidateRate > 0 && candidateRate < 500000) {
        rate = candidateRate;
      }
    }
    
    // MRP: usually the number before rate
    let mrp = rate;
    if (nums.length >= 4) {
      // Find MRP (should be >= rate)
      for (let i = 1; i < nums.length - 2; i++) {
        if (nums[i] >= rate && nums[i] < 500000) {
          mrp = nums[i];
          break;
        }
      }
    }
    
    // Determine GST
    const gst = gstPct >= 0 ? gstPct : gstFor(name);
    
    // Validate: amount should roughly equal qty * rate (within 50% tolerance for OCR errors)
    const expectedAmt = qty * rate;
    if (expectedAmt > 0 && Math.abs(amount - expectedAmt) / expectedAmt > 0.6 && nums.length > 2) {
      // Amount doesn't match qty*rate, so recalculate rate from amount
      rate = amount / qty;
      mrp = Math.max(mrp, rate);
    }

    add(name, qty, mrp, rate, gst, amount);
  }

  // ============================================================
  // STRATEGY B: BigBasket/standard invoice format (strict regex)
  // "Name Qty MRP Rate GST% Amount"
  // ============================================================
  if (items.length < 3) {
    for (const line of lines) {
      if (isSkip(line)) continue;
      const m = line.match(/^(.{3,60}?)\s+(\d{1,4}(?:\.\d{0,2})?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)\s+(\d{1,2})%\s+([\d,]+(?:\.\d{1,2})?)$/);
      if (m) {
        const name = m[1].trim(), qty = parseFloat(m[2]), mrp = parseFloat(m[3].replace(/,/g, '')), rate = parseFloat(m[4].replace(/,/g, '')), gst = parseInt(m[5]), amt = parseFloat(m[6].replace(/,/g, ''));
        if (qty > 0 && qty <= 9999 && rate > 0 && amt > 0) add(name, qty, mrp, rate, gst, amt);
      }
    }
  }

  // ============================================================
  // STRATEGY C: Qty x Name Amount
  // ============================================================
  if (items.length < 3) {
    for (const line of lines) {
      if (isSkip(line)) continue;
      const m = line.match(/^(\d{1,3})\s*[x×X]\s+(.{3,55}?)\s{2,}([\d,]{1,8}(?:\.\d{1,2})?)$/);
      if (m) {
        const qty = parseFloat(m[1]), name = m[2].trim(), amt = parseFloat(m[3].replace(/,/g, ''));
        if (qty > 0 && amt > 0) add(name, qty, amt / qty, amt / qty, gstFor(name), amt);
      }
    }
  }

  // ============================================================
  // STRATEGY D: Name ... Amount (2-column fallback)
  // ============================================================
  if (items.length < 2) {
    for (const line of lines) {
      if (isSkip(line)) continue;
      const m = line.match(/^(.{4,52}?)\s{2,}([\d,]{1,9}(?:\.\d{1,2})?)$/);
      if (m) {
        const name = m[1].replace(/^\d+[\.\/\)]\s*/, '').trim();
        const amt = parseFloat(m[2].replace(/,/g, ''));
        if (amt > 0.5 && amt < 200000 && name.length >= 3 && /[a-zA-Z]{3}/.test(name))
          add(name, 1, amt, amt, gstFor(name), amt);
      }
    }
  }

  return items.slice(0, 120);
}

/* ─── GST SLAB RULES ─── */
const GST_RULES = [
  { g: 0, k: ['salt', 'atta', 'flour', 'dal', 'pulse', 'rice', 'wheat', 'maida', 'poha', 'suji', 'semolina', 'ragi', 'bajra', 'rajma', 'chana', 'moong', 'toor', 'arhar', 'urad', 'masoor', 'besan', 'jowar', 'grain', 'lentil', 'chickpea'] },
  { g: 5, k: ['milk', 'curd', 'yogurt', 'dahi', 'ghee', 'paneer', 'butter', 'cream', 'cheese', 'oil', 'sugar', 'jaggery', 'tea', 'coffee', 'masala', 'spice', 'pickle', 'sauce', 'juice', 'water', 'rusk', 'bread', 'biscuit', 'cake', 'cereal', 'oats', 'cornflakes', 'muesli', 'honey', 'jam', 'noodles', 'pasta', 'basmati', 'soya', 'tofu', 'baby', 'health', 'whey', 'protein', 'turmeric', 'pepper', 'cumin', 'coriander', 'ginger', 'garlic', 'cardamom', 'clove', 'cinnamon', 'bay leaf', 'mustard', 'chilli', 'paprika', 'oregano', 'fruit', 'vegetable', 'veg', 'fresh', 'frozen veg', 'soda water', 'coconut water', 'nut milk', 'almond milk', 'soy milk'] },
  { g: 12, k: ['chips', 'namkeen', 'wafer', 'cracker', 'candy', 'toffee', 'chocolate', 'ice cream', 'popcorn', 'peanut', 'cashew', 'almond', 'walnut', 'nuts', 'raisin', 'dry fruit', 'energy bar', 'granola', 'roasted', 'bhujia', 'mixture', 'mathri', 'khakra', 'papad', 'chutney', 'achaar', 'ready to eat', 'dosa mix', 'idli mix', 'upma mix', 'biryani mix', 'soup', 'vermicelli', 'sewai', 'cornflour', 'arrowroot', 'cornstarch', 'custard', 'jelly', 'pickle jar', 'fruit jam', 'squash', 'cordial', 'tinned', 'canned', 'packaged'] },
  { g: 18, k: ['soap', 'shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'face wash', 'body wash', 'lotion', 'cream', 'hair oil', 'deo', 'deodorant', 'perfume', 'detergent', 'dish', 'floor cleaner', 'toilet', 'scrubber', 'sponge', 'sanitizer', 'hand wash', 'tissue', 'napkin', 'razor', 'blade', 'sanitary', 'pad', 'cotton', 'wipes', 'sunscreen', 'moisturiser', 'moisturizer', 'serum', 'toner', 'face mask', 'kajal', 'lipstick', 'nail polish', 'cologne', 'talcum', 'talc', 'powder', 'air freshener', 'mosquito', 'cockroach', 'pest', 'bleach', 'phenyl', 'vim', 'rin', 'surf', 'ariel', 'tide', 'harpic', 'lizol', 'domex', 'colin', 'dettol', 'lifebuoy', 'lux', 'pears', 'dove', 'head shoulders', 'pantene', 'clinic plus', 'tresemme', 'sunsilk'] },
  { g: 28, k: ['cold drink', 'soda', 'aerated', 'carbonated', 'pepsi', 'coke', 'cola', 'sprite', 'fanta', 'limca', 'thums up', 'redbull', 'monster', 'energy drink', 'beer', 'wine', 'whisky', 'rum', 'vodka', 'tobacco', 'cigarette', 'gutka', 'pan masala', 'supari'] },
];
function gstFor(name) {
  const n = name.toLowerCase();
  for (const rule of [...GST_RULES].reverse()) {
    if (rule.k.some(kw => n.includes(kw))) return rule.g;
  }
  if (/cream|lotion|wash|spray|care|clean|gel/.test(n)) return 18;
  if (/dal|grain|pulse|lentil|flour|whole|raw/.test(n)) return 0;
  return 5;
}

/* ─── DEMO BILLS ─── */
const DEMOS = {
  bigbasket: {
    store: 'BigBasket', billNo: 'BB-20251109-7823', date: '09 Nov 2025', gstin: '27AAACB1234F1ZK',
    items: [
      { name: 'Tata Salt 1kg', qty: 2, mrp: 24, rate: 22, gst: 0 },
      { name: 'Amul Taaza Milk 1L', qty: 4, mrp: 68, rate: 62, gst: 5 },
      { name: 'Fortune Sunflower Oil 1L', qty: 1, mrp: 185, rate: 175, gst: 5 },
      { name: 'Aashirvaad Atta 5kg', qty: 1, mrp: 280, rate: 265, gst: 0 },
      { name: 'Good Day Butter Cookies 200g', qty: 3, mrp: 40, rate: 36, gst: 12 },
      { name: 'Maggi Noodles 70g x4', qty: 2, mrp: 72, rate: 66, gst: 5 },
      { name: 'Colgate MaxFresh 200g', qty: 1, mrp: 115, rate: 105, gst: 18 },
      { name: 'Vim Dish Wash Bar 200g', qty: 2, mrp: 32, rate: 29, gst: 18 },
      { name: 'Parle-G Biscuits 500g', qty: 2, mrp: 52, rate: 48, gst: 12 },
      { name: 'Toor Dal 1kg', qty: 2, mrp: 155, rate: 148, gst: 0 },
      { name: 'Dettol Handwash 200ml', qty: 1, mrp: 89, rate: 82, gst: 18 },
      { name: 'Tropicana Orange Juice 1L', qty: 2, mrp: 135, rate: 122, gst: 5 },
    ]
  },
  dmart: {
    store: 'D-Mart', billNo: 'DMT-20251106-4491', date: '06 Nov 2025', gstin: '27AAVCD5678G1ZR',
    items: [
      { name: 'D-Mart White Sugar 1kg', qty: 2, mrp: 48, rate: 44, gst: 5 },
      { name: 'Saffola Active Oil 2L', qty: 1, mrp: 395, rate: 379, gst: 5 },
      { name: 'Chings Hakka Noodles 150g', qty: 3, mrp: 45, rate: 41, gst: 5 },
      { name: 'Dettol Soap 75g x3', qty: 1, mrp: 98, rate: 88, gst: 18 },
      { name: 'Rin Detergent Powder 500g', qty: 2, mrp: 62, rate: 56, gst: 18 },
      { name: 'Daawat Basmati Rice 5kg', qty: 1, mrp: 460, rate: 435, gst: 5 },
      { name: 'Britannia Bread 400g', qty: 2, mrp: 42, rate: 38, gst: 5 },
      { name: "Lay's Classic Salted 52g", qty: 4, mrp: 20, rate: 20, gst: 12 },
      { name: 'Moong Dal 500g', qty: 2, mrp: 78, rate: 72, gst: 0 },
      { name: 'Catch Black Pepper 50g', qty: 1, mrp: 65, rate: 60, gst: 5 },
    ]
  },
  blinkit: {
    store: 'Blinkit', billNo: 'BLK-20251105-2210', date: '05 Nov 2025', gstin: '',
    items: [
      { name: 'Epigamia Greek Yogurt 200g', qty: 3, mrp: 85, rate: 79, gst: 5 },
      { name: 'Paper Boat Aam Panna 200ml', qty: 6, mrp: 30, rate: 28, gst: 5 },
      { name: 'Amul Butter 500g', qty: 1, mrp: 280, rate: 268, gst: 5 },
      { name: 'Sunpure Refined Oil 1L', qty: 2, mrp: 172, rate: 159, gst: 5 },
      { name: "Head & Shoulders Shampoo 180ml", qty: 1, mrp: 248, rate: 228, gst: 18 },
      { name: 'Cadbury Dairy Milk 40g', qty: 5, mrp: 20, rate: 20, gst: 12 },
      { name: 'Tata Tea Gold 250g', qty: 1, mrp: 145, rate: 138, gst: 5 },
      { name: 'Hajmola Candy 30pcs', qty: 2, mrp: 35, rate: 32, gst: 12 },
    ]
  },
  zepto: {
    store: 'Zepto', billNo: 'ZPT-20251107-9934', date: '07 Nov 2025', gstin: '27AABCZ9999H1ZT',
    items: [
      { name: 'Farm Fresh Tomatoes 500g', qty: 2, mrp: 35, rate: 32, gst: 0 },
      { name: 'Onions 1kg', qty: 1, mrp: 45, rate: 40, gst: 0 },
      { name: 'Britannia Bourbon 100g', qty: 3, mrp: 30, rate: 28, gst: 12 },
      { name: 'Kissan Mixed Fruit Jam 200g', qty: 1, mrp: 95, rate: 88, gst: 5 },
      { name: 'Lifebuoy Soap 125g', qty: 3, mrp: 35, rate: 32, gst: 18 },
      { name: 'Aashirvaad Atta 2kg', qty: 2, mrp: 115, rate: 108, gst: 0 },
      { name: 'Wai Wai Noodles 75g', qty: 4, mrp: 15, rate: 14, gst: 5 },
      { name: 'Cornflakes 475g', qty: 1, mrp: 145, rate: 135, gst: 5 },
      { name: 'Surf Excel Quick Wash 500g', qty: 1, mrp: 125, rate: 118, gst: 18 },
    ]
  },
};

async function loadDemo(key) {
  const d = DEMOS[key]; if (!d) return;
  openModal(); S('m-prog'); H('m-up'); H('m-res');
  document.getElementById('m-fname').textContent = d.store + ' — Demo Bill';
  setStages([{ l: 'Loading demo', s: 'run' }, { l: 'Simulating parse', s: 'wait' }, { l: 'Detecting items', s: 'wait' }, { l: 'Calculating GST', s: 'wait' }]);
  setProg(0);
  await sl(300); setProg(30); sDone(0); sRun(1);
  await sl(260); setProg(58); sDone(1); sRun(2);
  await sl(300); setProg(82); sDone(2); sRun(3);

  const items = d.items.map(it => {
    const total = it.qty * it.rate;
    const taxable = total / (1 + it.gst / 100);
    const ga = total - taxable;
    return { ...it, total, taxable, cgst: ga / 2, sgst: ga / 2, gstAmt: ga };
  });
  const grandTotal = items.reduce((s, i) => s + i.total, 0);
  const totalGSTAmt = items.reduce((s, i) => s + i.gstAmt, 0);
  const slabs = {};
  items.forEach(it => {
    if (!slabs[it.gst]) slabs[it.gst] = { taxable: 0, gstAmt: 0, total: 0 };
    slabs[it.gst].taxable += it.taxable; slabs[it.gst].gstAmt += it.gstAmt; slabs[it.gst].total += it.total;
  });
  const flags = d.gstin ? [] : [{ type: 'warn', msg: 'No GSTIN — input credit blocked' }];
  const parsed = { ...d, items, flags, grandTotal, totalGSTAmt, slabs, id: Date.now() };

  await sl(280); setProg(100); sDone(3); await sl(200);
  showResult(parsed);
}

/* ─── SHOW RESULT ─── */
const GCOL = { 0: 'var(--mu)', 5: 'var(--bl)', 12: 'var(--g)', 18: 'var(--or)', 28: 'var(--re)' };
const GCLS = { 0: 'g0', 5: 'g5', 12: 'g12', 18: 'g18', 28: 'g28' };

function showResult(p) {
  _pend = p; S('m-res'); H('m-prog'); H('m-up');
  document.getElementById('r-sub').textContent = p.items.length + ' items detected';
  document.getElementById('r-store').textContent = p.store;
  document.getElementById('r-hdr').innerHTML = `
    <div class="ocr-f"><label>Store</label><span>${p.store}</span></div>
    <div class="ocr-f"><label>Bill No</label><span class="mono" style="font-size:11.5px">${p.billNo}</span></div>
    <div class="ocr-f"><label>Date</label><span>${p.date}</span></div>
    <div class="ocr-f"><label>GSTIN</label><span class="mono" style="font-size:11px;color:${p.gstin ? 'var(--g)' : 'var(--re)'}">${p.gstin || 'Not found'}</span></div>`;

  const tbody = document.getElementById('r-tbody');
  if (p.items.length === 0) { tbody.innerHTML = ''; S('r-noitems'); }
  else {
    H('r-noitems');
    tbody.innerHTML = p.items.map(it => `<tr>
      <td>${it.name}</td>
      <td class="mono">${it.qty}</td>
      <td class="mono" style="color:var(--mu)">₹${it.mrp.toFixed(2)}</td>
      <td class="mono">₹${it.rate.toFixed(2)}</td>
      <td><span class="gb ${GCLS[it.gst] || 'g5'}">${it.gst}%</span></td>
      <td class="mono fw7">₹${it.total.toFixed(2)}</td>
    </tr>`).join('');
  }

  document.getElementById('r-gst').innerHTML = Object.entries(p.slabs).sort((a, b) => +a[0] - +b[0]).map(([s, v]) => `
    <div class="gst-row">
      <span class="gb ${GCLS[s] || 'g5'}">GST ${s}%</span>
      <span class="mono">₹${v.taxable.toFixed(2)}</span>
      <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
      <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
      <span class="mono fw7" style="color:${GCOL[s] || 'var(--mu2)'}">₹${v.gstAmt.toFixed(2)}</span>
    </div>`).join('');
  document.getElementById('r-total').textContent = '₹' + p.grandTotal.toFixed(2);
}

/* ─── SAVE BILL ─── */
function saveBill() {
  if (!_pend) return;
  DB.bills.unshift(_pend);
  const b = _pend; _pend = null;
  updateSB(); closeModal();
  toast(`✓ ${b.items.length} items saved — ${b.store}  ₹${b.grandTotal.toFixed(2)}`, 'success');
  renderRecent();
  const cur = document.querySelector('.sb-link.on')?.dataset.pg;
  if (cur && cur !== 'scanner') { goPage(cur); }
}

/* ─── DOWNLOAD ─── */
function dlExcel(billArg) {
  const b = billArg || _pend || DB.bills[0]; if (!b) return;
  if (typeof XLSX === 'undefined') { toast('Excel library loading, try again in 2 seconds', 'warn'); return; }
  const wb = XLSX.utils.book_new();

  // Sheet 1: Items
  const rows = [['Item', 'Qty', 'MRP', 'Rate', 'GST%', 'Taxable Value', 'CGST', 'SGST', 'Total', 'Ledger']];
  b.items.forEach(it => {
    rows.push([it.name, it.qty, +it.mrp.toFixed(2), +it.rate.toFixed(2), it.gst + '%', +it.taxable.toFixed(2), +it.cgst.toFixed(2), +it.sgst.toFixed(2), +it.total.toFixed(2), ledger(it.name)]);
  });
  rows.push([]);
  rows.push(['', '', '', '', '', '', '', '', 'Grand Total', +b.grandTotal.toFixed(2)]);
  rows.push(['', '', '', '', '', '', '', '', 'Total GST', +b.totalGSTAmt.toFixed(2)]);
  const ws1 = XLSX.utils.aoa_to_sheet(rows);
  ws1['!cols'] = [{ wch: 40 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Items');

  // Sheet 2: GST Summary
  const gst = [['GST Slab', 'Taxable Value', 'CGST', 'SGST', 'Total GST', 'CGST Ledger', 'SGST Ledger']];
  Object.entries(b.slabs).sort((a, z) => +a[0] - +z[0]).forEach(([s, v]) => {
    gst.push(['GST ' + s + '%', +v.taxable.toFixed(2), +(v.gstAmt / 2).toFixed(2), +(v.gstAmt / 2).toFixed(2), +v.gstAmt.toFixed(2), 'CGST @' + (s / 2) + '%', 'SGST @' + (s / 2) + '%']);
  });
  gst.push(['TOTAL', +b.items.reduce((s, i) => s + i.taxable, 0).toFixed(2), +(b.totalGSTAmt / 2).toFixed(2), +(b.totalGSTAmt / 2).toFixed(2), +b.totalGSTAmt.toFixed(2), '', '']);
  const ws2 = XLSX.utils.aoa_to_sheet(gst);
  ws2['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'GST Summary');

  // Sheet 3: Bill Info
  const info = [['Field', 'Value'], ['Store', b.store], ['Bill No', b.billNo], ['Date', b.date], ['GSTIN', b.gstin || 'Not found'], ['Grand Total', 'Rs.' + b.grandTotal.toFixed(2)], ['Total GST', 'Rs.' + b.totalGSTAmt.toFixed(2)], ['Items', b.items.length]];
  const ws3 = XLSX.utils.aoa_to_sheet(info);
  ws3['!cols'] = [{ wch: 16 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'Bill Info');

  XLSX.writeFile(wb, 'FinBotics_' + b.store + '_' + b.billNo + '.xlsx');
}

function dlCSV() {
  const b = _pend; if (!b) return;
  let csv = 'Item,Qty,MRP,Rate,GST%,Taxable,CGST,SGST,Total,Ledger\n';
  b.items.forEach(it => { csv += `"${it.name}",${it.qty},${it.mrp.toFixed(2)},${it.rate.toFixed(2)},${it.gst}%,${it.taxable.toFixed(2)},${it.cgst.toFixed(2)},${it.sgst.toFixed(2)},${it.total.toFixed(2)},"${ledger(it.name)}"\n`; });
  dl(csv, `Grocery_${b.billNo}.csv`, 'text/csv');
}

/* ─── TALLY XML EXPORT ───────────────────────────────────────────────
   Generates a Purchase Voucher XML for TallyPrime.

   What happens inside Tally when you import this:
   - A Purchase voucher is created with the bill date & number
   - Each item's taxable value goes to its Purchase ledger (e.g. "Grocery Purchase")
   - CGST and SGST are split per slab into Input Tax ledgers
   - The supplier (BigBasket / D-Mart etc.) is credited the full amount

   Import steps:
   TallyPrime → Gateway of Tally → Import → Vouchers → select this file → Accept
─────────────────────────────────────────────────────────────────────── */
function dlTallyXML(b) {
  if (!b) { toast('No bill to export', 'warn'); return; }

  // "09 Nov 2025" → "20251109"  (Tally needs YYYYMMDD)
  const dt = tallyDt(b.date);

  // Escape XML special chars
  function xe(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // One purchase ledger entry per item (debit side)
  const itemEntries = b.items.map(it => `
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xe(ledger(it.name))}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${it.taxable.toFixed(2)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`).join('');

  // CGST + SGST entries, one pair per GST slab (debit — input tax credit)
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

  // Supplier ledger (credit — we owe them the grand total)
  const supplierEntry = `
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${xe(b.store)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${b.grandTotal.toFixed(2)}</AMOUNT>
            ${b.gstin ? `<PARTYGSTIN>${xe(b.gstin)}</PARTYGSTIN>` : ''}
          </ALLLEDGERENTRIES.LIST>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>
<!-- FinBotics Tally Export | ${xe(b.store)} | ${xe(b.billNo)} | ${xe(b.date)} | Total: Rs.${b.grandTotal.toFixed(2)} -->
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

  dl(xml, `Tally_${b.store}_${b.billNo}.xml`, 'application/xml');
  toast('Tally XML downloaded! TallyPrime → Import → Vouchers', 'success');
}

function exportAll() {
  if (!DB.bills.length) { toast('No bills scanned yet', 'warn'); return; }
  let csv = 'Bill No,Store,Date,Item,Qty,MRP,Rate,GST%,Taxable,CGST,SGST,Total,Ledger\n';
  DB.bills.forEach(b => {
    b.items.forEach(it => { csv += `"${b.billNo}","${b.store}","${b.date}","${it.name}",${it.qty},${it.mrp.toFixed(2)},${it.rate.toFixed(2)},${it.gst}%,${it.taxable.toFixed(2)},${it.cgst.toFixed(2)},${it.sgst.toFixed(2)},${it.total.toFixed(2)},"${ledger(it.name)}"\n`; });
  });
  dl(csv, `FinBotics_AllBills.csv`, 'text/csv');
}

/* ─── RENDER: RECENT SCANS ─── */
const ICO_COLORS = ['ico-g', 'ico-b', 'ico-o', 'ico-p'];
function renderRecent() {
  const n = DB.bills.length;
  document.getElementById('scan-lbl').textContent = n + ' scan' + (n !== 1 ? 's' : '');
  const el = document.getElementById('recent-list');
  if (!n) { el.innerHTML = `<div class="empty" style="padding:28px 10px"><div class="e-ico"><i class="fas fa-inbox"></i></div><p style="font-size:12px">No scans yet.</p></div>`; return; }
  el.innerHTML = DB.bills.map((b, i) => `
    <div class="scan-item" onclick="openDet(${b.id})">
      <div class="s-ico ${ICO_COLORS[i % 4]}"><i class="fas fa-receipt"></i></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600">${b.store}</div>
        <div style="font-size:11px;color:var(--mu)">${b.billNo} · ${b.date} · ${b.items.length} items${b.flags.length ? ' · <span style="color:var(--or)">' + b.flags.length + ' flag' + (b.flags.length > 1 ? 's' : '') + '</span>' : ''}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div class="mono fw7" style="color:var(--g);font-size:13px">₹${b.grandTotal.toFixed(2)}</div>
        <div style="font-size:10px;color:var(--mu)">GST ₹${b.totalGSTAmt.toFixed(2)}</div>
      </div>
    </div>`).join('');
}

/* ─── RENDER: DASHBOARD ─── */
function renderDash() {
  const has = DB.bills.length > 0;
  const spend = DB.bills.reduce((s, b) => s + b.grandTotal, 0);
  const gst = DB.bills.reduce((s, b) => s + b.totalGSTAmt, 0);
  const items = DB.bills.reduce((s, b) => s + b.items.length, 0);
  const flagged = DB.bills.filter(b => b.flags.length > 0);

  document.getElementById('dash-stats').innerHTML = `
    <div class="stat" onclick="goPage('invoices')">
      <div class="stat-lbl"><i class="fas fa-receipt"></i> Total Spend</div>
      <div class="stat-val" style="color:var(--g)">₹${nf(spend)}</div>
      <div class="stat-sub"><i class="fas fa-file-invoice" style="color:var(--g)"></i> ${DB.bills.length} bill${DB.bills.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="stat" onclick="goPage('analysis')">
      <div class="stat-lbl"><i class="fas fa-percent"></i> Total GST</div>
      <div class="stat-val" style="color:var(--bl)">₹${nf(gst)}</div>
      <div class="stat-sub"><i class="fas fa-arrow-right" style="color:var(--bl)"></i> ${spend > 0 ? (gst / spend * 100).toFixed(1) : 0}% of spend</div>
    </div>
    <div class="stat">
      <div class="stat-lbl"><i class="fas fa-box"></i> Items Tallied</div>
      <div class="stat-val" style="color:var(--or)">${items}</div>
      <div class="stat-sub" style="color:var(--mu)">Across all bills</div>
    </div>
    <div class="stat" onclick="goPage('reconcile')">
      <div class="stat-lbl"><i class="fas fa-flag"></i> Flagged</div>
      <div class="stat-val" style="color:${flagged.length ? 'var(--re)' : 'var(--g)'}">${flagged.length}</div>
      <div class="stat-sub" style="color:${flagged.length ? 'var(--or)' : 'var(--mu)'}"><i class="fas fa-${flagged.length ? 'exclamation-triangle' : 'check'}"></i> ${flagged.length ? 'Need review' : 'All clear'}</div>
    </div>`;

  const de = document.getElementById('dash-empty');
  const dd = document.getElementById('dash-data');
  if (!has) {
    de.innerHTML = `<div class="card"><div class="empty"><div class="e-ico"><i class="fas fa-chart-line"></i></div><h3>Dashboard is empty</h3><p>Scan your first grocery bill to see real data here.</p><button class="btn btn-g" onclick="goPage('scanner');openModal()"><i class="fas fa-plus"></i> Scan First Bill</button></div></div>`;
    de.style.display = ''; dd.style.display = 'none'; return;
  }
  de.innerHTML = ''; de.style.display = 'none'; dd.style.display = '';

  const maxS = Math.max(...DB.bills.map(b => b.grandTotal));
  dd.innerHTML = `
    <div class="g6040" style="margin-bottom:16px">
      <div class="card">
        <div class="ch"><div class="ct"><i class="fas fa-chart-bar" style="color:var(--g)"></i> Spend per Bill</div></div>
        <div class="barchart">${DB.bills.map((b, i) => {
    const p = (b.grandTotal / maxS) * 88;
    const c = i === 0 ? 'linear-gradient(180deg,var(--g),#00c988)' : 'var(--card3)';
    const bc = i === 0 ? 'var(--g)' : 'var(--b2)';
    return `<div class="bar-col"><div class="bar-v">₹${Math.round(b.grandTotal / 100) / 10}k</div><div class="bar" style="height:${p}%;background:${c};border:1px solid ${bc}"></div></div>`;
  }).join('')}</div>
        <div style="display:flex;gap:10px;margin-top:5px;font-size:9.5px;color:var(--mu);padding:0 4px">${DB.bills.map(b => `<span style="flex:1;text-align:center">${b.store.slice(0, 5)}</span>`).join('')}</div>
      </div>
      <div class="card">
        <div class="ch"><div class="ct"><i class="fas fa-percent" style="color:var(--bl)"></i> GST Slab Mix</div></div>
        ${(() => {
      const st = {};
      DB.bills.forEach(b => Object.entries(b.slabs).forEach(([s, v]) => { st[s] = (st[s] || 0) + v.gstAmt; }));
      const tot = Object.values(st).reduce((a, v) => a + v, 0);
      return Object.entries(st).sort((a, b) => +a[0] - +b[0]).map(([s, a]) => `
            <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
              <span class="gb ${GCLS[s] || 'g5'}" style="width:52px;text-align:center">GST ${s}%</span>
              <div style="flex:1;height:5px;background:var(--card3);border-radius:99px;overflow:hidden"><div style="width:${tot > 0 ? (a / tot * 100) : 0}%;height:100%;background:${GCOL[s] || 'var(--mu2)'};border-radius:99px"></div></div>
              <span class="mono" style="font-size:11.5px;color:${GCOL[s] || 'var(--mu2)'}">₹${a.toFixed(0)}</span>
            </div>`).join('');
    })()}
      </div>
    </div>
    <div class="card">
      <div class="ch"><div class="ct"><i class="fas fa-table" style="color:var(--or)"></i> All Items</div></div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Item</th><th>Store</th><th>Qty</th><th>Rate</th><th>GST</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>Total</th></tr></thead>
          <tbody>${DB.bills.flatMap(b => b.items.map(it => `
            <tr>
              <td>${it.name}</td>
              <td style="font-size:11px;color:var(--mu)">${b.store}</td>
              <td class="mono">${it.qty}</td>
              <td class="mono">₹${it.rate.toFixed(2)}</td>
              <td><span class="gb ${GCLS[it.gst] || 'g5'}">${it.gst}%</span></td>
              <td class="mono" style="color:var(--mu)">₹${it.taxable.toFixed(2)}</td>
              <td class="mono" style="color:var(--bl)">₹${it.cgst.toFixed(2)}</td>
              <td class="mono" style="color:var(--bl)">₹${it.sgst.toFixed(2)}</td>
              <td class="mono fw7" style="color:var(--g)">₹${it.total.toFixed(2)}</td>
            </tr>`)).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ─── RENDER: INVOICES ─── */
function renderInvoices() {
  const q = (document.getElementById('inv-q')?.value || '').toLowerCase();
  const f = document.getElementById('inv-f')?.value || 'all';
  const list = DB.bills.filter(b => {
    const m = b.store.toLowerCase().includes(q) || b.billNo.toLowerCase().includes(q);
    const fm = f === 'all' || (f === 'flag' && b.flags.length > 0) || (f === 'ok' && b.flags.length === 0);
    return m && fm;
  });
  const flagC = DB.bills.filter(b => b.flags.length > 0).length;
  document.getElementById('inv-sub').textContent = `${DB.bills.length} bill${DB.bills.length !== 1 ? 's' : ''} · ${flagC} flagged`;
  const el = document.getElementById('inv-body');
  if (!DB.bills.length) {
    el.innerHTML = `<div class="empty"><div class="e-ico"><i class="fas fa-file-invoice"></i></div><h3>No invoices yet</h3><p>Scan a bill and it will appear here.</p><button class="btn btn-g" onclick="goPage('scanner');openModal()"><i class="fas fa-plus"></i> Scan First Bill</button></div>`;
    return;
  }
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Bill No</th><th>Store</th><th>Date</th><th>Items</th><th>Total</th><th>GST</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(b => `
      <tr>
        <td class="mono" style="font-size:12px">${b.billNo}</td>
        <td style="font-weight:600">${b.store}</td>
        <td style="font-size:12px;color:var(--mu)">${b.date}</td>
        <td class="mono">${b.items.length}</td>
        <td class="mono fw7" style="color:var(--g)">₹${b.grandTotal.toFixed(2)}</td>
        <td class="mono" style="color:var(--bl)">₹${b.totalGSTAmt.toFixed(2)}</td>
        <td><span class="sbadge ${b.flags.length ? 's-fl' : 's-ok'}">${b.flags.length ? 'Flagged' : 'Matched'}</span></td>
        <td><button class="btn-ghost" style="padding:5px 10px;font-size:11.5px" onclick="openDet(${b.id})"><i class="fas fa-eye"></i></button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

/* ─── RENDER: RECONCILE ─── */
function renderReconcile() {
  const flagged = DB.bills.filter(b => b.flags.length > 0);
  const el = document.getElementById('rec-body');
  if (!DB.bills.length) { el.innerHTML = `<div class="empty"><div class="e-ico"><i class="fas fa-arrows-rotate"></i></div><h3>No data yet</h3><p>Scan bills first.</p><button class="btn btn-g" onclick="goPage('scanner');openModal()"><i class="fas fa-plus"></i> Scan a Bill</button></div>`; return; }
  if (!flagged.length) { el.innerHTML = `<div class="card"><div class="empty" style="padding:40px"><div class="e-ico" style="border-color:var(--g);color:var(--g)"><i class="fas fa-check"></i></div><h3 style="color:var(--g)">All Clear!</h3><p>No flagged bills. ${DB.bills.length} bill${DB.bills.length > 1 ? 's' : ''} reconciled.</p></div></div>`; return; }
  el.innerHTML = `<div class="card">
    <div class="ch"><div class="ct"><i class="fas fa-flag" style="color:var(--or)"></i> Flagged Bills (${flagged.length})</div></div>
    ${flagged.map(b => `
      <div style="display:flex;align-items:center;gap:13px;padding:13px 0;border-bottom:1px solid var(--b1)">
        <div style="width:36px;height:36px;border-radius:9px;background:var(--ord);display:flex;align-items:center;justify-content:center;color:var(--or);flex-shrink:0"><i class="fas fa-exclamation-triangle"></i></div>
        <div style="flex:1"><div style="font-size:13px;font-weight:600">${b.store} — ${b.billNo}</div>${b.flags.map(f => `<div style="font-size:11.5px;color:var(--mu)">${f.msg}</div>`).join('')}</div>
        <div style="text-align:right;flex-shrink:0">
          <div class="mono fw7" style="color:var(--or)">₹${b.grandTotal.toFixed(2)}</div>
          <button class="btn btn-g" style="margin-top:6px;font-size:11px;padding:5px 11px" onclick="openDet(${b.id})"><i class="fas fa-eye"></i> View</button>
        </div>
      </div>`).join('')}
  </div>`;
}

/* ─── RENDER: ANALYSIS ─── */
function renderAnalysis() {
  const el = document.getElementById('ana-body');
  if (!DB.bills.length) { el.innerHTML = `<div class="empty"><div class="e-ico"><i class="fas fa-chart-pie"></i></div><h3>No data yet</h3><p>Scan at least one bill.</p><button class="btn btn-g" onclick="goPage('scanner');openModal()"><i class="fas fa-plus"></i> Scan a Bill</button></div>`; return; }
  const cats = {};
  DB.bills.forEach(b => b.items.forEach(it => { const c = ledger(it.name); cats[c] = (cats[c] || 0) + it.total; }));
  const catTotal = Object.values(cats).reduce((s, v) => s + v, 0);
  const stores = {};
  DB.bills.forEach(b => { stores[b.store] = (stores[b.store] || 0) + b.grandTotal; });
  const CC = ['var(--g)', 'var(--bl)', 'var(--or)', 'var(--ye)', 'var(--pu)', 'var(--re)', 'var(--mu2)'];

  // Combined GST across all bills
  const allSlabs = {};
  DB.bills.forEach(b => Object.entries(b.slabs).forEach(([s, v]) => {
    if (!allSlabs[s]) allSlabs[s] = { taxable: 0, gstAmt: 0 };
    allSlabs[s].taxable += v.taxable; allSlabs[s].gstAmt += v.gstAmt;
  }));
  const totalGST = DB.bills.reduce((s, b) => s + b.totalGSTAmt, 0);

  el.innerHTML = `
    <div class="g2" style="margin-bottom:16px">
      <div class="card">
        <div class="ch"><div class="ct"><i class="fas fa-chart-pie" style="color:var(--g)"></i> Spend by Category</div></div>
        ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, a], i) => `
          <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
            <div style="width:7px;height:7px;border-radius:2px;background:${CC[i % CC.length]};flex-shrink:0"></div>
            <span style="flex:1;font-size:12px;color:var(--mu2)">${c}</span>
            <div style="width:80px;height:5px;background:var(--card3);border-radius:99px;overflow:hidden"><div style="width:${(a / catTotal * 100).toFixed(1)}%;height:100%;background:${CC[i % CC.length]};border-radius:99px"></div></div>
            <span class="mono" style="font-size:12px;min-width:56px;text-align:right">₹${a.toFixed(0)}</span>
          </div>`).join('')}
      </div>
      <div class="card">
        <div class="ch"><div class="ct"><i class="fas fa-store" style="color:var(--bl)"></i> Spend by Store</div></div>
        ${Object.entries(stores).sort((a, b) => b[1] - a[1]).map(([s, a]) => `
          <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--b1);font-size:13px">
            <span style="font-weight:600">${s}</span><span class="mono fw7" style="color:var(--g)">₹${a.toFixed(2)}</span>
          </div>`).join('')}
        <div style="display:flex;justify-content:space-between;padding:11px 0;font-size:13.5px;font-weight:700">
          <span>Total</span><span class="mono" style="color:var(--g)">₹${DB.bills.reduce((s, b) => s + b.grandTotal, 0).toFixed(2)}</span>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="ch"><div class="ct"><i class="fas fa-percent" style="color:var(--bl)"></i> GST Summary — All Bills</div></div>
      <div class="gst-hdr"><span>Slab</span><span>Taxable Value</span><span>CGST</span><span>SGST</span><span>Total GST</span></div>
      ${Object.entries(allSlabs).sort((a, b) => +a[0] - +b[0]).map(([s, v]) => `
        <div class="gst-row">
          <span class="gb ${GCLS[s] || 'g5'}">GST ${s}%</span>
          <span class="mono">₹${v.taxable.toFixed(2)}</span>
          <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
          <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
          <span class="mono fw7" style="color:${GCOL[s] || 'var(--mu2)'}">₹${v.gstAmt.toFixed(2)}</span>
        </div>`).join('')}
      <div class="gst-foot" style="margin-top:10px;padding-top:10px">
        <span style="font-weight:700">Grand Total GST</span>
        <span class="mono fw7" style="color:var(--g);font-size:16px">₹${totalGST.toFixed(2)}</span>
      </div>
    </div>`;
}

/* ─── DETAIL MODAL ─── */
function openDet(id) {
  const b = DB.bills.find(x => x.id === id); if (!b) return;
  document.getElementById('det-body').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--b1)">
      <div>
        <h2 style="font-family:'Instrument Serif',serif;font-style:italic;font-size:20px;margin-bottom:3px">${b.store}</h2>
        <div style="font-size:12px;color:var(--mu)">${b.billNo} · ${b.date}${b.gstin ? ' · <span style="color:var(--g)">' + b.gstin + '</span>' : ' · <span style="color:var(--re)">No GSTIN</span>'}</div>
      </div>
      <div style="text-align:right">
        <div class="mono fw7" style="font-size:22px;color:var(--g)">₹${b.grandTotal.toFixed(2)}</div>
        <div style="font-size:12px;color:var(--mu)">GST ₹${b.totalGSTAmt.toFixed(2)}</div>
      </div>
    </div>
    ${b.flags.map(f => `<div class="note note-warn" style="margin-bottom:8px"><i class="fas fa-exclamation-triangle"></i><span style="color:var(--mu2)">${f.msg}</span></div>`).join('')}
    <div class="tbl-wrap" style="margin-bottom:14px">
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>GST</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>Total</th><th>Ledger</th></tr></thead>
        <tbody>${b.items.map(it => `
          <tr>
            <td>${it.name}</td>
            <td class="mono">${it.qty}</td>
            <td class="mono">₹${it.rate.toFixed(2)}</td>
            <td><span class="gb ${GCLS[it.gst] || 'g5'}">${it.gst}%</span></td>
            <td class="mono" style="color:var(--mu)">₹${it.taxable.toFixed(2)}</td>
            <td class="mono" style="color:var(--bl)">₹${it.cgst.toFixed(2)}</td>
            <td class="mono" style="color:var(--bl)">₹${it.sgst.toFixed(2)}</td>
            <td class="mono fw7" style="color:var(--g)">₹${it.total.toFixed(2)}</td>
            <td style="font-size:11px;color:var(--mu)">${ledger(it.name)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="gst-sum">
      <div class="gst-hdr"><span>Slab</span><span>Taxable</span><span>CGST</span><span>SGST</span><span>GST Total</span></div>
      ${Object.entries(b.slabs).sort((a, x) => +a[0] - +x[0]).map(([s, v]) => `
        <div class="gst-row">
          <span class="gb ${GCLS[s] || 'g5'}">GST ${s}%</span>
          <span class="mono">₹${v.taxable.toFixed(2)}</span>
          <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
          <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
          <span class="mono fw7" style="color:${GCOL[s] || 'var(--mu2)'}">₹${v.gstAmt.toFixed(2)}</span>
        </div>`).join('')}
      <div class="gst-foot"><span style="font-weight:700">Grand Total</span><span class="mono fw7" style="color:var(--g);font-size:17px">₹${b.grandTotal.toFixed(2)}</span></div>
    </div>
    <div style="display:flex;gap:9px;margin-top:14px;flex-wrap:wrap">
      <button class="btn btn-g" style="background:linear-gradient(135deg,#0096c7,#0077b6)" onclick="dlTallyXML(DB.bills.find(x=>x.id===${b.id}))"><i class="fas fa-file-import"></i> Tally XML</button>
      <button class="btn btn-o" onclick="dlExcel(DB.bills.find(x=>x.id===${b.id}))"><i class="fas fa-file-excel"></i> Excel</button>
      <button class="btn btn-o" onclick="exportBill(${b.id})"><i class="fas fa-download"></i> CSV</button>
      <button class="btn-ghost" style="margin-left:auto;border-color:rgba(255,71,87,.3);color:var(--re)" onclick="delBill(${b.id})"><i class="fas fa-trash"></i> Delete</button>
    </div>`;
  document.getElementById('det-modal').classList.add('show');
}

function exportBill(id) {
  const b = DB.bills.find(x => x.id === id); if (!b) return;
  let csv = 'Item,Qty,MRP,Rate,GST%,Taxable,CGST,SGST,Total,Ledger\n';
  b.items.forEach(it => { csv += `"${it.name}",${it.qty},${it.mrp.toFixed(2)},${it.rate.toFixed(2)},${it.gst}%,${it.taxable.toFixed(2)},${it.cgst.toFixed(2)},${it.sgst.toFixed(2)},${it.total.toFixed(2)},"${ledger(it.name)}"\n`; });
  dl(csv, `${b.store}_${b.billNo}.csv`, 'text/csv');
}

function delBill(id) {
  if (!confirm('Delete this bill?')) return;
  DB.bills = DB.bills.filter(x => x.id !== id);
  closeDet(); updateSB(); renderRecent();
  toast('Bill deleted', 'info');
}

/* ─── TALLY HELPERS ─── */
function ledger(name) {
  const n = name.toLowerCase();
  if (/soap|shampoo|toothpaste|toothbrush|face\s*wash|body\s*wash|lotion|deo|deodorant|sanitizer|hand\s*wash|tissue|razor|sanitary|pad|cotton|wipes|sunscreen|talc/.test(n)) return 'Personal Care';
  if (/detergent|dish|floor|toilet\s*clean|scrub|sponge|vim|rin|surf|harpic|phenyl|bleach/.test(n)) return 'Household Cleaning';
  if (/milk|curd|yogurt|dahi|ghee|paneer|butter|cream|cheese/.test(n)) return 'Dairy Purchase';
  if (/oil/.test(n)) return 'Cooking Oil Purchase';
  if (/biscuit|cookie|chips|namkeen|chocolate|candy|wafer|popcorn|snack/.test(n)) return 'Snacks & Confectionery';
  if (/dal|pulse|rajma|chana|moong|toor|masoor|lentil/.test(n)) return 'Pulses Purchase';
  if (/rice|wheat|atta|flour|maida|grain/.test(n)) return 'Staples Purchase';
  if (/tea|coffee|juice|drink|water|soda/.test(n)) return 'Beverages Purchase';
  return 'Grocery Purchase';
}
function tallyDt(d) {
  const M = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const p = d.split(' ');
  if (p.length === 3) return `${p[2]}${M[p[1].toLowerCase()] || '01'}${p[0].padStart(2, '0')}`;
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}
function ex(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* ─── SIDEBAR BADGES ─── */
function updateSB() {
  const sc = document.getElementById('sb-cnt');
  const sf = document.getElementById('sb-flag');
  const f = DB.bills.filter(b => b.flags.length > 0).length;
  sc.style.display = DB.bills.length ? '' : 'none'; sc.textContent = DB.bills.length;
  sf.style.display = f ? '' : 'none'; sf.textContent = f;
}

/* ─── SETTINGS ─── */
function clearAll() {
  if (!confirm('Delete all scanned bills?')) return;
  DB.bills = []; updateSB(); renderRecent(); toast('All data cleared', 'info');
}

/* ─── STAGE / PROGRESS HELPERS ─── */
function setProg(p) { const e = document.getElementById('m-pbar'); if (e) e.style.width = p + '%'; }
function setStages(s) {
  document.getElementById('m-stages').innerHTML = s.map((x, i) => `
    <div class="stage"><div class="sdot ${x.s === 'run' ? 'sr' : x.s === 'done' ? 'sd' : 'sw'}" id="sd${i}">${x.s === 'done' ? '✓' : x.s === 'run' ? '◌' : '○'}</div><span>${x.l}</span></div>`).join('');
}
function sDone(i) { const e = document.getElementById('sd' + i); if (e) { e.className = 'sdot sd'; e.textContent = '✓'; } }
function sRun(i) { const e = document.getElementById('sd' + i); if (e) { e.className = 'sdot sr'; e.textContent = '◌'; } }

/* ─── DOM / UTIL ─── */
function S(id) { const e = document.getElementById(id); if (e) e.style.display = ''; }
function H(id) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
function sl(ms) { return new Promise(r => setTimeout(r, ms)); }
function nf(n) { return Math.round(n).toLocaleString('en-IN'); }
function dl(content, name, type) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([content], { type })), download: name });
  a.click(); URL.revokeObjectURL(a.href);
}
function toast(msg, type = 'info') {
  const C = { success: 'var(--g)', warn: 'var(--ye)', error: 'var(--re)', info: 'var(--bl)' };
  const I = { success: 'check-circle', warn: 'triangle-exclamation', error: 'circle-xmark', info: 'circle-info' };
  const t = document.createElement('div');
  t.className = 'toast'; t.style.borderLeft = `3px solid ${C[type]}`;
  t.innerHTML = `<i class="fas fa-${I[type]}" style="color:${C[type]}"></i><span>${msg}</span>`;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* ─── FINBOT CHATBOT APIS ─── */
const DEFAULT_GEMINI_KEY = 'AIzaSyCEjP1Z82StSdy-_fmCE3QyOJVipXejF0Y';

function getGeminiKey() {
  return localStorage.getItem('gemini_api_key') || DEFAULT_GEMINI_KEY;
}

function setGeminiKey() {
  const currentKey = localStorage.getItem('gemini_api_key') || '';
  const newKey = prompt('Enter your Google Gemini API Key:\n(Leave blank to keep current key, or type "clear" to remove it)', currentKey ? '********' : '');
  if (newKey) {
    if (newKey.toLowerCase() === 'clear') {
      localStorage.removeItem('gemini_api_key');
      toast('Gemini API Key removed. Using default key.', 'info');
    } else if (newKey !== '********') {
      localStorage.setItem('gemini_api_key', newKey.trim());
      toast('Gemini API Key saved successfully!', 'success');
    }
  }
}

// Chat UI Controls
let chatOpen = false;
function toggleChat() {
  const container = document.getElementById('fin-chat');
  const icon = document.getElementById('chat-icon');
  chatOpen = !chatOpen;
  if (chatOpen) {
    container.classList.remove('closed');
    icon.className = 'fas fa-chevron-down';
  } else {
    container.classList.add('closed');
    icon.className = 'fas fa-chevron-up';
  }
}

// Init chat to closed state
document.addEventListener('DOMContentLoaded', () => {
  const chatDOM = document.getElementById('fin-chat');
  if (chatDOM) chatDOM.classList.add('closed');
});

function appendMsg(text, sender) {
  const body = document.getElementById('chat-body');
  const div = document.createElement('div');
  div.className = `msg ${sender}`;

  // Basic markdown to HTML
  let formattedHtml = text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  if (!formattedHtml.startsWith('<p>')) {
    formattedHtml = '<p>' + formattedHtml + '</p>';
  }

  div.innerHTML = formattedHtml;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

function showTyping() {
  const body = document.getElementById('chat-body');
  const div = document.createElement('div');
  div.className = 'typing';
  div.id = 'chat-typing';
  div.innerHTML = '<span></span><span></span><span></span>';
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

async function askFinBot() {
  const inp = document.getElementById('chat-in');
  const query = inp.value.trim();
  if (!query) return;

  inp.value = '';
  appendMsg(query, 'user');

  const apiKey = getGeminiKey();

  showTyping();

  try {
    const summary = DB.bills.map(b =>
      `Bill: ${b.store} | Total: ${b.grandTotal} | Items: ${b.items.map(i => i.name + ' (Rs' + i.total + ')').join(', ')}`
    ).join('\n');

    const promptText = `
You are "FinBot," the intelligent financial assistant for FinBotics, a grocery bill management suite.
USER: Yuvika (Admin).
TONE: Professional, efficient, slightly witty, supportive, grounded. Never hallucinate data. If asked about unsupported data tell them it's not present.
CONSTRAINTS: You process data locally. Never claim to store data on a server. Use Markdown for bolding. Keep responses concise to fit a chat bubble. 
If user asks about photo support, explain that scanned photo PDFs won't work—only digital PDFs are supported.
If user asks for export help, explain Tally import (Gateway of Tally -> Import -> Vouchers -> Select XML -> Accept).

DATA SUMMARY OF CURRENT USER BILLS:
${summary || 'No bills scanned yet.'}

USER QUERY: ${query}
`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }]
      })
    });

    const data = await res.json();
    hideTyping();

    if (data.error) {
      appendMsg("Oops! API Error: " + data.error.message, 'bot');
    } else if (data.candidates && data.candidates[0].content) {
      const reply = data.candidates[0].content.parts[0].text;
      appendMsg(reply, 'bot');
    } else {
      appendMsg("Hmm, I got an empty response from the API.", 'bot');
    }
  } catch (err) {
    hideTyping();
    appendMsg("Oops, something went wrong calling the Gemini API. Check your connection or API key.", 'bot');
    console.error(err);
  }
}

/* ═══════════════════════════════════════════════════════
   OCR SCANNER — Tesseract.js-powered bill image scanning
   ═══════════════════════════════════════════════════════ */
const OCRDB = { bills: [] };
let _ocrPend = null;

/* — File/Camera triggers — */
function triggerOCRFile() { document.getElementById('ocr-file-in').click(); }
function openOCRCamera() { document.getElementById('ocr-camera-in').click(); }

function handleOCRFile(inp) {
  const f = inp.files[0]; inp.value = '';
  if (!f) return;
  // Accept image/* and also HEIC (iPhone)
  if (!f.type.startsWith('image/') && !f.name.toLowerCase().endsWith('.heic') && !f.name.toLowerCase().endsWith('.heif')) {
    toast('Please select an image file', 'warn'); return;
  }
  processOCRImage(f);
}

/* — Drag+drop for OCR zone — */
['dragover', 'dragleave', 'drop'].forEach(ev => {
  const el = document.getElementById('ocr-dz');
  if (!el) return;
  el.addEventListener(ev, e => {
    e.preventDefault();
    if (ev === 'dragover') el.classList.add('drag');
    else if (ev === 'dragleave') el.classList.remove('drag');
    else {
      el.classList.remove('drag');
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) processOCRImage(f);
      else toast('Drop an image file (JPG, PNG, etc.)', 'warn');
    }
  });
});

/* — Advanced Image preprocessing for receipt OCR — */
function preprocessForOCR(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      let w = img.width, h = img.height;

      // Step 1: Upscale small images — Tesseract needs text to be at least ~30px tall
      // Receipt text is often tiny; upscaling 2x dramatically improves accuracy
      const MIN_DIM = 1800;
      const MAX_DIM = 3200;
      if (Math.max(w, h) < MIN_DIM) {
        const scale = MIN_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      } else if (Math.max(w, h) > MAX_DIM) {
        const scale = MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

      // Step 2: Convert to grayscale
      const imageData = ctx.getImageData(0, 0, w, h);
      const d = imageData.data;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < d.length; i += 4) {
        gray[i / 4] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      }

      // Step 3: Adaptive thresholding (local mean method)
      // This handles uneven lighting on receipts (shadows, flash hotspots)
      const blockSize = 25; // neighborhood size
      const C = 12; // constant subtracted from mean
      const binary = new Uint8Array(w * h);
      
      // Compute integral image for fast local mean
      const integral = new Float64Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) {
        let rowSum = 0;
        for (let x = 0; x < w; x++) {
          rowSum += gray[y * w + x];
          integral[(y + 1) * (w + 1) + (x + 1)] = rowSum + integral[y * (w + 1) + (x + 1)];
        }
      }

      const half = Math.floor(blockSize / 2);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const x1 = Math.max(0, x - half);
          const y1 = Math.max(0, y - half);
          const x2 = Math.min(w - 1, x + half);
          const y2 = Math.min(h - 1, y + half);
          const count = (x2 - x1 + 1) * (y2 - y1 + 1);
          const sum = integral[(y2 + 1) * (w + 1) + (x2 + 1)]
                    - integral[y1 * (w + 1) + (x2 + 1)]
                    - integral[(y2 + 1) * (w + 1) + x1]
                    + integral[y1 * (w + 1) + x1];
          const mean = sum / count;
          binary[y * w + x] = gray[y * w + x] > (mean - C) ? 255 : 0;
        }
      }

      // Step 4: Morphological cleaning — remove isolated noise dots
      // Simple 3x3 median filter on the binary image
      const cleaned = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          // Count white neighbors in 3x3
          let whites = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (binary[(y + dy) * w + (x + dx)] > 0) whites++;
            }
          }
          cleaned[y * w + x] = whites >= 5 ? 255 : 0; // majority vote
        }
      }

      // Step 5: Write back to canvas
      for (let i = 0; i < cleaned.length; i++) {
        const v = cleaned[i];
        d[i * 4] = v;
        d[i * 4 + 1] = v;
        d[i * 4 + 2] = v;
        d[i * 4 + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);

      // Convert to high-quality PNG (lossless — important for OCR)
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas blob conversion failed'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = URL.createObjectURL(file);
  });
}

/* — Post-process OCR text to fix common Tesseract errors on receipts — */
function cleanOCRText(rawText) {
  let text = rawText;
  
  // Fix common character confusions in number contexts
  // Replace isolated O/o with 0 when surrounded by digits
  text = text.replace(/(\d)[Oo](\d)/g, '$1'+'0'+'$2');
  text = text.replace(/(\d)[Oo]$/gm, '$1'+'0');
  text = text.replace(/^[Oo](\d)/gm, '0$1');
  
  // Replace l/I with 1 when in number contexts
  text = text.replace(/(\d)[lI](\d)/g, '$1'+'1'+'$2');
  text = text.replace(/(\d)[lI]$/gm, '$1'+'1');
  
  // Fix S/$ appearing instead of 5 in numbers
  text = text.replace(/(\d)[S$](\d)/g, '$1'+'5'+'$2');
  
  // Fix B appearing instead of 8 in numbers
  text = text.replace(/(\d)B(\d)/g, '$1'+'8'+'$2');
  
  // Normalize whitespace: replace multiple spaces with single, but preserve line structure
  text = text.replace(/[^\S\n]+/g, ' ');
  
  // Remove zero-width and special unicode characters
  text = text.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  
  return text;
}

/* — Main OCR pipeline — */
async function processOCRImage(file) {
  // Show preview
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('ocr-preview-img').src = e.target.result;
    document.getElementById('ocr-preview-wrap').style.display = '';
  };
  reader.readAsDataURL(file);

  // Show processing
  document.getElementById('ocr-processing').style.display = '';
  document.getElementById('ocr-results').style.display = 'none';
  document.getElementById('ocr-pbar').style.width = '5%';
  document.getElementById('ocr-status').textContent = 'Preprocessing image…';

  try {
    // Preprocess: adaptive binarization, upscale, clean
    document.getElementById('ocr-status').textContent = 'Enhancing image for OCR…';
    document.getElementById('ocr-pbar').style.width = '10%';
    let ocrInput;
    try {
      ocrInput = await preprocessForOCR(file);
    } catch (e) {
      console.warn('Preprocessing failed, using raw file:', e);
      ocrInput = file;
    }

    document.getElementById('ocr-status').textContent = 'Loading Tesseract.js engine…';
    document.getElementById('ocr-pbar').style.width = '15%';

    // Run OCR with PSM 6 (uniform text block — best for receipts)
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          const p = Math.round(m.progress * 100);
          document.getElementById('ocr-pbar').style.width = Math.max(20, Math.round(20 + p * 0.35)) + '%';
          document.getElementById('ocr-status').textContent = 'Pass 1: Recognizing text… ' + p + '%';
        } else if (m.status) {
          document.getElementById('ocr-status').textContent = m.status;
        }
      }
    });

    document.getElementById('ocr-pbar').style.width = '25%';
    document.getElementById('ocr-status').textContent = 'Processing (pass 1 — block mode)…';

    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });

    const result1 = await worker.recognize(ocrInput);
    const text1 = result1.data.text;

    // Pass 2: Try PSM 4 (column detection — handles multi-column receipts)
    document.getElementById('ocr-status').textContent = 'Pass 2: Column detection…';
    document.getElementById('ocr-pbar').style.width = '60%';

    await worker.setParameters({
      tessedit_pageseg_mode: '4',
      preserve_interword_spaces: '1',
    });
    const result2 = await worker.recognize(ocrInput);
    const text2 = result2.data.text;

    // Pass 3: Also try with raw file (no preprocessing) to catch what binarization missed
    document.getElementById('ocr-status').textContent = 'Pass 3: Raw image scan…';
    document.getElementById('ocr-pbar').style.width = '80%';
    
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });
    const result3 = await worker.recognize(file);
    const text3 = result3.data.text;

    await worker.terminate();

    document.getElementById('ocr-pbar').style.width = '95%';
    document.getElementById('ocr-status').textContent = 'Analyzing results…';

    // Clean all results
    const cleaned1 = cleanOCRText(text1);
    const cleaned2 = cleanOCRText(text2);
    const cleaned3 = cleanOCRText(text3);

    // Parse all three and pick the best result
    const parsed1 = parseGrocery(cleaned1, file.name || 'ocr_scan');
    const parsed2 = parseGrocery(cleaned2, file.name || 'ocr_scan');
    const parsed3 = parseGrocery(cleaned3, file.name || 'ocr_scan');

    // Score each result: more items + GSTIN found = better
    const score = p => p.items.length * 10 + (p.gstin ? 50 : 0) + (p.grandTotal > 0 ? 20 : 0);
    let best = parsed1, bestText = cleaned1;
    if (score(parsed2) > score(best)) { best = parsed2; bestText = cleaned2; }
    if (score(parsed3) > score(best)) { best = parsed3; bestText = cleaned3; }

    // If best didn't find GSTIN but another pass did, use that GSTIN
    if (!best.gstin) {
      if (parsed1.gstin) best.gstin = parsed1.gstin;
      else if (parsed2.gstin) best.gstin = parsed2.gstin;
      else if (parsed3.gstin) best.gstin = parsed3.gstin;
    }
    // Remove the "no GSTIN" flag if we found one from another pass
    if (best.gstin) {
      best.flags = best.flags.filter(f => !f.msg.includes('GSTIN'));
    }

    best.source = 'ocr';

    document.getElementById('ocr-pbar').style.width = '100%';
    document.getElementById('ocr-status').textContent = 'OCR complete!';

    // Show all 3 pass outputs in raw text for debugging
    document.getElementById('ocr-raw-text').textContent = 
      '=== PASS 1 (Block Mode - Preprocessed) ===\n' + cleaned1 +
      '\n\n=== PASS 2 (Column Mode - Preprocessed) ===\n' + cleaned2 +
      '\n\n=== PASS 3 (Block Mode - Raw Image) ===\n' + cleaned3 +
      '\n\n=== BEST RESULT: Pass ' + (best === parsed1 ? '1' : best === parsed2 ? '2' : '3') +
      ' (Score: ' + score(best) + ', Items: ' + best.items.length + ')';

    await sl(300);
    document.getElementById('ocr-processing').style.display = 'none';
    showOCRResult(best);

  } catch (err) {
    console.error('OCR Error:', err);
    document.getElementById('ocr-processing').style.display = 'none';
    toast('OCR failed: ' + err.message, 'error');
  }
}

/* — Show OCR results — */
function showOCRResult(p) {
  _ocrPend = p;
  document.getElementById('ocr-results').style.display = '';
  document.getElementById('ocr-r-sub').textContent = p.items.length + ' items detected';
  document.getElementById('ocr-r-store').textContent = p.store;

  document.getElementById('ocr-r-hdr').innerHTML = `
    <div class="ocr-f"><label>Store</label><span>${p.store}</span></div>
    <div class="ocr-f"><label>Bill No</label><span class="mono" style="font-size:11.5px">${p.billNo}</span></div>
    <div class="ocr-f"><label>Date</label><span>${p.date}</span></div>
    <div class="ocr-f"><label>GSTIN</label><span class="mono" style="font-size:11px;color:${p.gstin ? 'var(--g)' : 'var(--re)'}">${p.gstin || 'Not found'}</span></div>
    <div class="ocr-f"><label>Source</label><span style="color:var(--bl)"><i class="fas fa-camera" style="margin-right:4px"></i>OCR Scan</span></div>`;

  const tbody = document.getElementById('ocr-r-tbody');
  if (p.items.length === 0) {
    tbody.innerHTML = '';
    document.getElementById('ocr-r-noitems').style.display = '';
    document.getElementById('ocr-gst-sum').style.display = 'none';
  } else {
    document.getElementById('ocr-r-noitems').style.display = 'none';
    document.getElementById('ocr-gst-sum').style.display = '';
    tbody.innerHTML = p.items.map(it => `<tr>
      <td>${it.name}</td>
      <td class="mono">${it.qty}</td>
      <td class="mono" style="color:var(--mu)">₹${it.mrp.toFixed(2)}</td>
      <td class="mono">₹${it.rate.toFixed(2)}</td>
      <td><span class="gb ${GCLS[it.gst] || 'g5'}">${it.gst}%</span></td>
      <td class="mono fw7">₹${it.total.toFixed(2)}</td>
    </tr>`).join('');
  }

  document.getElementById('ocr-r-gst').innerHTML = Object.entries(p.slabs).sort((a, b) => +a[0] - +b[0]).map(([s, v]) => `
    <div class="gst-row">
      <span class="gb ${GCLS[s] || 'g5'}">GST ${s}%</span>
      <span class="mono">₹${v.taxable.toFixed(2)}</span>
      <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
      <span class="mono" style="color:var(--bl)">₹${(v.gstAmt / 2).toFixed(2)}</span>
      <span class="mono fw7" style="color:${GCOL[s] || 'var(--mu2)'}">₹${v.gstAmt.toFixed(2)}</span>
    </div>`).join('');
  document.getElementById('ocr-r-total').textContent = '₹' + p.grandTotal.toFixed(2);

  toast(`✓ OCR scan complete — ${p.items.length} items from ${p.store}`, 'success');
}

/* — Save OCR bill to shared DB — */
function saveOCRBill() {
  if (!_ocrPend) return;
  // Save to both DB and OCRDB
  DB.bills.unshift(_ocrPend);
  OCRDB.bills.unshift(_ocrPend);
  const b = _ocrPend; _ocrPend = null;
  updateSB(); renderOCRRecent();
  toast(`✓ OCR bill saved — ${b.items.length} items · ₹${b.grandTotal.toFixed(2)}`, 'success');
}

/* — Reset OCR scanner — */
function resetOCR() {
  _ocrPend = null;
  document.getElementById('ocr-results').style.display = 'none';
  document.getElementById('ocr-processing').style.display = 'none';
  document.getElementById('ocr-preview-wrap').style.display = 'none';
  document.getElementById('ocr-raw-text').style.display = 'none';
}

/* — OCR Recent scans list — */
function renderOCRRecent() {
  const n = OCRDB.bills.length;
  const lbl = document.getElementById('ocr-scan-lbl');
  if (lbl) lbl.textContent = n + ' scan' + (n !== 1 ? 's' : '');
  const el = document.getElementById('ocr-recent-list');
  if (!el) return;
  if (!n) {
    el.innerHTML = `<div class="empty" style="padding:28px 10px"><div class="e-ico"><i class="fas fa-camera"></i></div><p style="font-size:12px">No OCR scans yet.<br>Upload or capture a bill image to get started.</p></div>`;
    return;
  }
  el.innerHTML = OCRDB.bills.map((b, i) => `
    <div class="scan-item" onclick="openDet(${b.id})">
      <div class="s-ico ${ICO_COLORS[i % 4]}" style="position:relative"><i class="fas fa-camera"></i></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600">${b.store} <span style="font-size:10px;color:var(--bl);background:var(--bld);padding:1px 6px;border-radius:99px;margin-left:4px">OCR</span></div>
        <div style="font-size:11px;color:var(--mu)">${b.billNo} · ${b.date} · ${b.items.length} items</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div class="mono fw7" style="color:var(--g);font-size:13px">₹${b.grandTotal.toFixed(2)}</div>
        <div style="font-size:10px;color:var(--mu)">GST ₹${b.totalGSTAmt.toFixed(2)}</div>
      </div>
    </div>`).join('');
}

/* — OCR Export helpers — */
function dlOCRExcel() {
  const b = _ocrPend; if (!b) return;
  dlExcel(b);
}
function dlOCRCsv() {
  const b = _ocrPend; if (!b) return;
  let csv = 'Item,Qty,MRP,Rate,GST%,Taxable,CGST,SGST,Total,Ledger\n';
  b.items.forEach(it => { csv += `"${it.name}",${it.qty},${it.mrp.toFixed(2)},${it.rate.toFixed(2)},${it.gst}%,${it.taxable.toFixed(2)},${it.cgst.toFixed(2)},${it.sgst.toFixed(2)},${it.total.toFixed(2)},"${ledger(it.name)}"\n`; });
  dl(csv, `OCR_${b.store}_${b.billNo}.csv`, 'text/csv');
}