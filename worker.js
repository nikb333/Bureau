// ================================================================
// Bureau Ops Worker — Single File Build
// Deploy via Cloudflare Dashboard: Workers & Pages → Create Worker → Edit Code → Paste this
// ================================================================

// ================================================================
// GOOGLE AUTH — Service account JWT signing (Web Crypto API)
// ================================================================

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

function parseServiceAccount(raw) {
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: SCOPES.join(" "),
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const enc = new TextEncoder();
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPrivateKey(serviceAccount.private_key);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    enc.encode(signingInput)
  );
  const jwt = `${signingInput}.${base64url(sig)}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    expires_at: now + (data.expires_in || 3600),
  };
}

function base64url(input) {
  let b64;
  if (typeof input === "string") {
    b64 = btoa(input);
  } else {
    const bytes = new Uint8Array(input);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    b64 = btoa(binary);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
  const stripped = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// ================================================================
// GOOGLE SHEETS — Read/write the clean Bureau Ops Data sheet
// ================================================================
//
// Tab "Orders" — one row per PO:
//   A:ID  B:Region  C:Ref  D:Invoice  E:Supplier  F:Currency  G:TotalValue
//   H:DepositAmt  I:DepositStatus  J:DepositDue  K:DepositPaid
//   L:ReleaseAmt  M:ReleaseStatus  N:ReleaseDue  O:ReleasePaid
//   P:Notes  Q:DriveFolderID  R:Created  S:Updated  T:PODate
//
// Tab "Payments" — one row per payment:
//   A:ID  B:BankAccount  C:SourceEntity  D:Amount  E:Currency
//   F:PaymentDate  G:PaymentType  H:OrderIDs  I:Allocations(JSON)
//   J:Notes  K:DocName  L:Created

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

const ORDER_HEADERS = [
  "ID", "Region", "Ref", "Invoice", "Supplier", "Currency", "Total Value",
  "Deposit Amt", "Deposit Status", "Deposit Due", "Deposit Paid",
  "Release Amt", "Release Status", "Release Due", "Release Paid",
  "Notes", "Drive Folder ID", "Created", "Updated", "PO Date"
];

const PAYMENT_HEADERS = [
  "ID", "Bank Account", "Source Entity", "Amount", "Currency",
  "Payment Date", "Payment Type", "Order IDs", "Allocations",
  "Notes", "Doc Name", "Created"
];

async function ensureSheetStructure(token, sheetId) {
  const base = `${SHEETS_BASE}/${sheetId}`;
  const metaRes = await gfetch(`${base}?fields=sheets.properties.title`, token);
  const meta = await metaRes.json();
  const existingTabs = (meta.sheets || []).map(s => s.properties.title);

  const requests = [];
  if (!existingTabs.includes("Orders")) {
    requests.push({ addSheet: { properties: { title: "Orders" } } });
  }
  if (!existingTabs.includes("Payments")) {
    requests.push({ addSheet: { properties: { title: "Payments" } } });
  }
  if (requests.length > 0) {
    await gfetch(`${base}:batchUpdate`, token, "POST", { requests });
  }

  const ordersA1 = await readRange(token, sheetId, "Orders", "A1:A1");
  if (!ordersA1.length || !ordersA1[0][0]) {
    await writeRange(token, sheetId, "Orders", "A1", [ORDER_HEADERS]);
  }
  const paymentsA1 = await readRange(token, sheetId, "Payments", "A1:A1");
  if (!paymentsA1.length || !paymentsA1[0][0]) {
    await writeRange(token, sheetId, "Payments", "A1", [PAYMENT_HEADERS]);
  }
}

// --- Orders CRUD ---

async function getAllOrders(token, sheetId) {
  const rows = await readRange(token, sheetId, "Orders", "A2:T5000");
  return rows.filter(r => r[0]).map(rowToOrder);
}

async function addOrder(token, sheetId, order) {
  const now = new Date().toISOString().slice(0, 19);
  const row = [
    order.id, order.region, order.ref, order.inv || "", order.supplier || "",
    order.currency || "USD", order.totalValue || 0,
    order.depositAmt || 0, order.depositStatus || "unpaid", order.depositDue || "", order.depositPaid || "",
    order.releaseAmt || 0, order.releaseStatus || "unpaid", order.releaseDue || "", order.releasePaid || "",
    order.notes || "", order.driveFolderId || "", order.created || now, now,
    order.poDate || "",
  ];
  await appendRows(token, sheetId, "Orders", [row]);
  return rowToOrder(row);
}

async function updateOrder(token, sheetId, orderId, updates) {
  const rows = await readRange(token, sheetId, "Orders", "A2:T5000");
  const idx = rows.findIndex(r => r[0] === orderId);
  if (idx === -1) throw new Error(`Order not found: ${orderId}`);
  const row = rows[idx];
  const sheetRow = idx + 2;

  if (updates.region !== undefined) row[1] = updates.region;
  if (updates.ref !== undefined) row[2] = updates.ref;
  if (updates.inv !== undefined) row[3] = updates.inv;
  if (updates.supplier !== undefined) row[4] = updates.supplier;
  if (updates.currency !== undefined) row[5] = updates.currency;
  if (updates.totalValue !== undefined) row[6] = updates.totalValue;
  if (updates.depositAmt !== undefined) row[7] = updates.depositAmt;
  if (updates.depositStatus !== undefined) row[8] = updates.depositStatus;
  if (updates.depositDue !== undefined) row[9] = updates.depositDue;
  if (updates.depositPaid !== undefined) row[10] = updates.depositPaid;
  if (updates.releaseAmt !== undefined) row[11] = updates.releaseAmt;
  if (updates.releaseStatus !== undefined) row[12] = updates.releaseStatus;
  if (updates.releaseDue !== undefined) row[13] = updates.releaseDue;
  if (updates.releasePaid !== undefined) row[14] = updates.releasePaid;
  if (updates.notes !== undefined) row[15] = updates.notes;
  if (updates.driveFolderId !== undefined) row[16] = updates.driveFolderId;
  if (updates.poDate !== undefined) row[19] = updates.poDate;
  row[18] = new Date().toISOString().slice(0, 19);

  await writeRange(token, sheetId, "Orders", `A${sheetRow}:T${sheetRow}`, [row]);
  return rowToOrder(row);
}

async function deleteOrder(token, sheetId, orderId) {
  const rows = await readRange(token, sheetId, "Orders", "A2:T5000");
  const idx = rows.findIndex(r => r[0] === orderId);
  if (idx === -1) throw new Error(`Order not found: ${orderId}`);
  const sheetRow = idx + 2;

  // Use batchUpdate to delete the row
  const meta = await gfetch(`${SHEETS_BASE}/${sheetId}?fields=sheets(properties(sheetId,title))`, token);
  const metaData = await meta.json();
  const ordersSheet = metaData.sheets.find(s => s.properties.title === "Orders");
  if (!ordersSheet) throw new Error("Orders sheet not found");

  const batchRes = await gfetch(`${SHEETS_BASE}/${sheetId}:batchUpdate`, token, "POST", {
    requests: [{
      deleteDimension: {
        range: {
          sheetId: ordersSheet.properties.sheetId,
          dimension: "ROWS",
          startIndex: sheetRow - 1,
          endIndex: sheetRow
        }
      }
    }]
  });

  return { success: true, deletedId: orderId };
}

function rowToOrder(row) {
  return {
    id: row[0] || "", region: row[1] || "", ref: row[2] || "", inv: row[3] || "",
    supplier: row[4] || "", currency: row[5] || "USD", totalValue: num(row[6]),
    depositAmt: num(row[7]), depositStatus: row[8] || "",
    depositDue: row[9] || "", depositPaid: row[10] || "",
    releaseAmt: num(row[11]), releaseStatus: row[12] || "",
    releaseDue: row[13] || "", releasePaid: row[14] || "",
    notes: row[15] || "", driveFolderId: row[16] || "",
    created: row[17] || "", updated: row[18] || "",
    poDate: row[19] || "",
  };
}

// --- Payments CRUD ---

async function getAllPayments(token, sheetId) {
  const rows = await readRange(token, sheetId, "Payments", "A2:L5000");
  return rows.filter(r => r[0]).map(rowToPayment);
}

async function addPayment(token, sheetId, payment) {
  const now = new Date().toISOString().slice(0, 19);
  const row = [
    payment.id, payment.bankAccount || "", payment.sourceEntity || "",
    payment.amount || 0, payment.currency || "USD",
    payment.date || now.slice(0, 10), payment.type || "Deposit",
    (payment.orderIds || []).join(","), JSON.stringify(payment.allocations || {}),
    payment.notes || "", payment.docName || "", now,
  ];
  await appendRows(token, sheetId, "Payments", [row]);
  return rowToPayment(row);
}

async function updatePayment(token, sheetId, paymentId, updates) {
  const rows = await readRange(token, sheetId, "Payments", "A2:L5000");
  const idx = rows.findIndex(r => r[0] === paymentId);
  if (idx === -1) throw new Error(`Payment not found: ${paymentId}`);
  const row = rows[idx];
  const sheetRow = idx + 2;

  if (updates.bankAccount !== undefined) row[1] = updates.bankAccount;
  if (updates.sourceEntity !== undefined) row[2] = updates.sourceEntity;
  if (updates.amount !== undefined) row[3] = updates.amount;
  if (updates.currency !== undefined) row[4] = updates.currency;
  if (updates.date !== undefined) row[5] = updates.date;
  if (updates.type !== undefined) row[6] = updates.type;
  if (updates.orderIds !== undefined) row[7] = updates.orderIds.join(",");
  if (updates.allocations !== undefined) row[8] = JSON.stringify(updates.allocations);
  if (updates.notes !== undefined) row[9] = updates.notes;
  if (updates.docName !== undefined) row[10] = updates.docName;

  await writeRange(token, sheetId, "Payments", `A${sheetRow}:L${sheetRow}`, [row]);
  return rowToPayment(row);
}

async function deletePayment(token, sheetId, paymentId) {
  const rows = await readRange(token, sheetId, "Payments", "A2:L5000");
  const idx = rows.findIndex(r => r[0] === paymentId);
  if (idx === -1) throw new Error(`Payment not found: ${paymentId}`);
  const sheetRow = idx + 2;

  // Use batchUpdate to delete the row
  const meta = await gfetch(`${SHEETS_BASE}/${sheetId}?fields=sheets(properties(sheetId,title))`, token);
  const metaData = await meta.json();
  const paymentsSheet = metaData.sheets.find(s => s.properties.title === "Payments");
  if (!paymentsSheet) throw new Error("Payments sheet not found");

  const batchRes = await gfetch(`${SHEETS_BASE}/${sheetId}:batchUpdate`, token, "POST", {
    requests: [{
      deleteDimension: {
        range: {
          sheetId: paymentsSheet.properties.sheetId,
          dimension: "ROWS",
          startIndex: sheetRow - 1,
          endIndex: sheetRow
        }
      }
    }]
  });

  return { success: true, deletedId: paymentId };
}

function rowToPayment(row) {
  const orderIdsStr = (row[7] || "").toString();
  const orderIds = orderIdsStr ? orderIdsStr.split(",").map(s => s.trim()).filter(Boolean) : [];
  let allocations = {};
  try { allocations = JSON.parse(row[8] || "{}"); } catch (e) { /* ignore */ }
  return {
    id: row[0] || "", bankAccount: row[1] || "", sourceEntity: row[2] || "",
    amount: num(row[3]), currency: row[4] || "USD", date: row[5] || "",
    type: row[6] || "Deposit", orderIds, allocations,
    notes: row[9] || "", docName: row[10] || "", created: row[11] || "",
  };
}

// --- Migration from old V2 sheet ---

const OLD_SHEET_ID = "1TQc_U51AhrlaTlStOLyLp-OJLDtUk4sSvdeDERyaHl8";
const COUNTRY_TABS = ["AU Stock Orders", "UK Stock Orders", "US Stock Orders", "CA Stock Orders"];
const REGION_FROM_TAB = { "AU Stock Orders": "AU", "UK Stock Orders": "UK", "US Stock Orders": "US", "CA Stock Orders": "CA" };
const SUPPLIER_KEYWORDS = ["Soundbox", "Hecor", "Dawon", "Sunon"];

async function migrateFromOldSheet(token, newSheetId) {
  const allOrders = new Map();
  const allPayments = [];

  for (const tab of COUNTRY_TABS) {
    const region = REGION_FROM_TAB[tab];
    let rows;
    try {
      rows = await readRange(token, OLD_SHEET_ID, tab, "A1:Z500");
    } catch (e) {
      console.warn(`Skipping tab "${tab}": ${e.message}`);
      continue;
    }
    if (!rows.length) continue;

    let headerIdx = -1;
    let colMap = {};
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const r = rows[i].map(c => (c || "").toString().toLowerCase().trim());
      const refCol = r.findIndex(c => c === "ref" || c === "po ref" || c === "reference" || c.includes("ref"));
      if (refCol >= 0) { headerIdx = i; colMap = buildColMap(rows[i]); break; }
    }
    if (headerIdx === -1) {
      headerIdx = 1;
      colMap = { region: 0, ref: 1, inv: 2, type: 4, currency: 5, amount: 6, usd: 7, due: 8, paid: 9, notes: 10, priority: 11 };
    }

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 3) continue;
      const ref = getCol(row, colMap, "ref");
      if (!ref || ref.toUpperCase().includes("PAID INVOICE") || ref.toUpperCase() === "REGION") continue;
      const poKey = extractPOKey(ref);
      if (!poKey) continue;

      const type = normalizeType(getCol(row, colMap, "type"));
      const amount = parseAmount(getCol(row, colMap, "amount"));
      const usdEquiv = parseAmount(getCol(row, colMap, "usd")) || amount;
      const currency = getCol(row, colMap, "currency") || "USD";
      const dueDate = parseDate(getCol(row, colMap, "due"));
      const paidDate = parseDate(getCol(row, colMap, "paid"));
      const notes = getCol(row, colMap, "notes");
      const priority = getCol(row, colMap, "priority");
      const inv = getCol(row, colMap, "inv");
      const supplier = detectSupplier(notes) || detectSupplier(ref);
      const rowRegion = getCol(row, colMap, "region") || region;

      if (!allOrders.has(poKey)) {
        allOrders.set(poKey, {
          id: poKey, region: normalizeRegion(rowRegion) || region,
          ref: ref, inv: inv, supplier: supplier, currency: currency, totalValue: 0,
          depositAmt: 0, depositStatus: "unpaid", depositDue: "", depositPaid: "",
          releaseAmt: 0, releaseStatus: "unpaid", releaseDue: "", releasePaid: "",
          notes: "", driveFolderId: "", created: new Date().toISOString().slice(0, 19),
        });
      }

      const order = allOrders.get(poKey);
      if (ref.length > order.ref.length) order.ref = ref;
      if (inv && (!order.inv || inv.length > order.inv.length)) order.inv = inv;
      if (supplier && !order.supplier) order.supplier = supplier;
      if (notes && !order.notes.includes(notes)) {
        order.notes = order.notes ? `${order.notes}; ${notes}` : notes;
      }

      if (type === "Deposit" || type === "Full Amount") {
        order.depositAmt = usdEquiv;
        order.depositDue = dueDate;
        if (paidDate) { order.depositStatus = "paid"; order.depositPaid = paidDate; }
        else if (dueDate) { order.depositStatus = "due"; }
      } else if (type === "Release") {
        order.releaseAmt = usdEquiv;
        order.releaseDue = dueDate;
        if (paidDate) { order.releaseStatus = "paid"; order.releasePaid = paidDate; }
        else if (dueDate) { order.releaseStatus = "due"; }
      }

      if (paidDate && amount > 0) {
        const sourceEntity = detectPaymentSource(notes, priority) || region;
        allPayments.push({
          id: `mig-${poKey}-${type.toLowerCase()}-${region}`,
          bankAccount: entityToBank(sourceEntity), sourceEntity: sourceEntity,
          amount: usdEquiv, currency: "USD", date: paidDate, type: type,
          orderIds: [poKey], allocations: { [poKey]: usdEquiv },
          notes: notes, docName: "",
        });
      }
    }
  }

  for (const order of allOrders.values()) {
    order.totalValue = order.depositAmt + order.releaseAmt;
  }

  const orders = Array.from(allOrders.values());
  if (orders.length > 0) {
    const orderRows = orders.map(o => {
      const now = new Date().toISOString().slice(0, 19);
      return [o.id, o.region, o.ref, o.inv || "", o.supplier || "", o.currency || "USD",
        o.totalValue || 0, o.depositAmt || 0, o.depositStatus || "unpaid",
        o.depositDue || "", o.depositPaid || "", o.releaseAmt || 0,
        o.releaseStatus || "unpaid", o.releaseDue || "", o.releasePaid || "",
        o.notes || "", o.driveFolderId || "", o.created || now, now];
    });
    await appendRows(token, newSheetId, "Orders", orderRows);
  }

  const seenPmts = new Set();
  const uniquePayments = allPayments.filter(p => {
    if (seenPmts.has(p.id)) return false;
    seenPmts.add(p.id); return true;
  });
  if (uniquePayments.length > 0) {
    const paymentRows = uniquePayments.map(p => {
      const now = new Date().toISOString().slice(0, 19);
      return [p.id, p.bankAccount || "", p.sourceEntity || "", p.amount || 0,
        p.currency || "USD", p.date || "", p.type || "Deposit",
        (p.orderIds || []).join(","), JSON.stringify(p.allocations || {}),
        p.notes || "", p.docName || "", now];
    });
    await appendRows(token, newSheetId, "Payments", paymentRows);
  }

  return { ordersImported: orders.length, paymentsImported: uniquePayments.length };
}

// --- Sheets helpers ---

async function readRange(token, sheetId, tab, range) {
  const fullRange = `'${tab}'!${range}`;
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(fullRange)}`;
  const res = await gfetch(url, token);
  if (!res.ok) throw new Error(`Sheets read "${tab}" failed (${res.status}): ${await res.text()}`);
  return (await res.json()).values || [];
}

async function writeRange(token, sheetId, tab, range, values) {
  const fullRange = `'${tab}'!${range}`;
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(fullRange)}?valueInputOption=USER_ENTERED`;
  const res = await gfetch(url, token, "PUT", { values });
  if (!res.ok) throw new Error(`Sheets write failed: ${await res.text()}`);
  return res.json();
}

async function appendRows(token, sheetId, tab, rows) {
  const range = `'${tab}'!A:A`;
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await gfetch(url, token, "POST", { values: rows });
  if (!res.ok) throw new Error(`Sheets append failed: ${await res.text()}`);
  return res.json();
}

async function gfetch(url, token, method = "GET", body = null) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

// --- Parsing helpers ---

function num(v) {
  if (!v && v !== 0) return 0;
  const n = parseFloat(v.toString().replace(/[,$£€¥\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function parseDate(s) {
  if (!s) return "";
  const str = s.toString().trim();
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  if (str.match(/^\d{4}-\d{2}-\d{2}/)) return str.slice(0, 10);
  if (/^\d{5}$/.test(str)) {
    const d = new Date((parseInt(str) - 25569) * 86400000);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const dt = new Date(str);
  if (!isNaN(dt)) return dt.toISOString().slice(0, 10);
  return "";
}

function parseAmount(s) {
  if (!s) return 0;
  const n = parseFloat(s.toString().replace(/[,$£€¥\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function normalizeType(t) {
  const lower = (t || "").toLowerCase().trim();
  if (lower.includes("deposit")) return "Deposit";
  if (lower.includes("release") || lower.includes("balance")) return "Release";
  if (lower.includes("full")) return "Full Amount";
  return "Deposit";
}

function normalizeRegion(r) {
  const upper = (r || "").toUpperCase().trim();
  if (["AU", "UK", "US", "CA"].includes(upper)) return upper;
  if (upper.includes("GB") || upper.includes("UK")) return "UK";
  if (upper.includes("US") || upper.includes("USA")) return "US";
  if (upper.includes("AU")) return "AU";
  if (upper.includes("CA")) return "CA";
  return "";
}

function extractPOKey(ref) {
  const match = ref.match(/PO[\s\-_]*(\d+)/i);
  if (match) return `PO-${match[1]}`;
  return ref.trim().replace(/\s+/g, "-");
}

function detectSupplier(text) {
  if (!text) return "";
  for (const s of SUPPLIER_KEYWORDS) {
    if (text.toLowerCase().includes(s.toLowerCase())) return s;
  }
  return "";
}

function detectPaymentSource(notes, priority) {
  const combined = `${notes || ""} ${priority || ""}`.toLowerCase();
  if (combined.includes("paid from uk") || combined.includes("from gb")) return "UK";
  if (combined.includes("paid from us") || combined.includes("from usa")) return "US";
  if (combined.includes("paid from ca") || combined.includes("from canada")) return "CA";
  if (combined.includes("paid from au") || combined.includes("from australia")) return "AU";
  return "";
}

function entityToBank(entity) {
  return { AU: "au-nab", UK: "uk-hsbc", US: "us-chase", CA: "ca-rbc" }[entity] || "";
}

function buildColMap(headerRow) {
  const normalized = headerRow.map(c => (c || "").toString().toLowerCase().trim());
  const find = (keys) => {
    for (const k of keys) {
      const idx = normalized.findIndex(c => c.includes(k));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  return {
    region: find(["region", "entity", "country"]),
    ref: find(["ref", "po ref", "po reference", "po #", "po no"]),
    inv: find(["inv", "invoice"]),
    type: find(["deposit", "type", "payment type", "pmt"]),
    currency: find(["currency", "curr", "ccy"]),
    amount: find(["amount", "value", "total"]),
    usd: find(["usd equiv", "usd", "us$"]),
    due: find(["due date", "due"]),
    paid: find(["paid date", "paid"]),
    notes: find(["notes", "note", "comment"]),
    priority: find(["priority", "prio"]),
  };
}

function getCol(row, colMap, field) {
  const idx = colMap[field];
  if (idx === undefined || idx < 0 || idx >= row.length) return "";
  return (row[idx] || "").toString().trim();
}

// ================================================================
// GOOGLE DRIVE — PO folders inside "Supplier purchase orders"
// ================================================================

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

let driveParentFolderId = null;
let supplierFolderCache = null;

async function getParentFolderId(token) {
  if (driveParentFolderId) return driveParentFolderId;
  const q = encodeURIComponent(
    "name = 'Supplier purchase orders' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
  );
  const res = await fetch(`${DRIVE_BASE}/files?q=${q}&fields=files(id,name)&pageSize=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive search failed: ${await res.text()}`);
  const data = await res.json();
  if (!data.files?.length) {
    throw new Error('Folder "Supplier purchase orders" not found. Share it with the service account.');
  }
  driveParentFolderId = data.files[0].id;
  return driveParentFolderId;
}

async function getSupplierFolders(token) {
  if (supplierFolderCache) return supplierFolderCache;
  const pid = await getParentFolderId(token);
  const q = encodeURIComponent(
    `'${pid}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const res = await fetch(
    `${DRIVE_BASE}/files?q=${q}&fields=files(id,name)&pageSize=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive list suppliers failed: ${await res.text()}`);
  const files = (await res.json()).files || [];
  supplierFolderCache = new Map();
  files.forEach(f => supplierFolderCache.set(f.name, f.id));
  return supplierFolderCache;
}

async function driveListFolders(token) {
  const suppliers = await getSupplierFolders(token);
  const allFolders = [];
  for (const [supplierName, supplierId] of suppliers) {
    const q = encodeURIComponent(
      `'${supplierId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    const res = await fetch(
      `${DRIVE_BASE}/files?q=${q}&fields=files(id,name,webViewLink,createdTime)&pageSize=200&orderBy=name`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) continue;
    const files = (await res.json()).files || [];
    files.forEach(f => allFolders.push({ ...f, supplier: supplierName }));
  }
  return allFolders;
}

async function driveCreateFolder(token, folderName, supplier) {
  const existing = await driveListFolders(token);
  const found = existing.find(f => f.name.toLowerCase() === folderName.toLowerCase());
  if (found) return found;

  const suppliers = await getSupplierFolders(token);
  let targetParent = null;
  let isNewSupplier = false;

  if (supplier) {
    targetParent = suppliers.get(supplier) ||
      [...suppliers.entries()].find(([k]) => k.toLowerCase() === supplier.toLowerCase())?.[1];

    if (!targetParent) {
      const pid = await getParentFolderId(token);
      const newRes = await fetch(`${DRIVE_BASE}/files?fields=id,name,webViewLink`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: supplier,
          mimeType: "application/vnd.google-apps.folder",
          parents: [pid],
        }),
      });
      if (!newRes.ok) throw new Error(`Failed to create supplier folder: ${await newRes.text()}`);
      const newFolder = await newRes.json();
      targetParent = newFolder.id;
      suppliers.set(supplier, targetParent);
      isNewSupplier = true;
    }
  }

  if (!targetParent) targetParent = await getParentFolderId(token);

  const res = await fetch(`${DRIVE_BASE}/files?fields=id,name,webViewLink`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [targetParent],
    }),
  });
  if (!res.ok) throw new Error(`Drive create folder failed: ${await res.text()}`);
  const folder = await res.json();
  folder.isNewSupplier = isNewSupplier;
  folder.supplier = supplier || "";
  return folder;
}

async function driveListFiles(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = "files(id,name,mimeType,webViewLink,webContentLink,size,createdTime)";
  const res = await fetch(
    `${DRIVE_BASE}/files?q=${q}&fields=${fields}&pageSize=100&orderBy=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive list files failed: ${await res.text()}`);
  return (await res.json()).files || [];
}

async function driveUploadFile(token, { folderId, fileName, mimeType, body }) {
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const boundary = "bureau_ops_" + Date.now();
  const bytes = new Uint8Array(body);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
  }
  const b64 = btoa(binary);
  const fullBody =
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}` +
    `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}` +
    `\r\n--${boundary}--`;

  const res = await fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: fullBody,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${await res.text()}`);
  return res.json();
}

async function driveFindFolder(token, poRef) {
  const folders = await driveListFolders(token);
  const poNum = poRef.match(/\d+/)?.[0];
  return (
    folders.find(f => f.name === poRef) ||
    folders.find(f => poNum && f.name.includes(`PO-${poNum}`)) ||
    null
  );
}

// ================================================================
// WORKER ENTRY POINT — Routing + CORS
// ================================================================

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExpiry > now + 60) return cachedToken;
  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT);
  const result = await getAccessToken(sa);
  cachedToken = result.access_token;
  cachedTokenExpiry = result.expires_at;
  return cachedToken;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function err(message, status = 500, origin) {
  return json({ error: message }, status, origin);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const origin = request.headers.get("Origin") || "*";

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const sheetId = env.SHEET_ID || "";
    if (!sheetId && !path.includes("/health")) {
      return err("SHEET_ID not configured. Add it in Worker Settings → Variables.", 500, origin);
    }

    try {
      // Health
      if (path === "/api/health") {
        return json({ status: "ok", sheetConfigured: !!sheetId, timestamp: new Date().toISOString() }, 200, origin);
      }

      // Setup — create sheet tabs + headers
      if (path === "/api/setup" && method === "POST") {
        const token = await getToken(env);
        await ensureSheetStructure(token, sheetId);
        return json({ success: true, message: "Sheet structure verified. Orders + Payments tabs ready." }, 200, origin);
      }

      // Migration — one-time import from old V2 sheet
      if (path === "/api/migrate" && method === "POST") {
        const token = await getToken(env);
        await ensureSheetStructure(token, sheetId);
        const existing = await getAllOrders(token, sheetId);
        if (existing.length > 0) {
          return json({
            success: false,
            message: `Sheet already has ${existing.length} orders. Clear the Orders tab first to re-migrate.`,
          }, 409, origin);
        }
        const result = await migrateFromOldSheet(token, sheetId);
        return json({
          success: true,
          message: `Imported ${result.ordersImported} orders and ${result.paymentsImported} payments.`,
          ...result,
        }, 200, origin);
      }

      // GET /api/orders
      if (path === "/api/orders" && method === "GET") {
        const token = await getToken(env);
        const orders = await getAllOrders(token, sheetId);
        return json({ orders, count: orders.length }, 200, origin);
      }

      // POST /api/orders
      if (path === "/api/orders" && method === "POST") {
        const token = await getToken(env);
        const body = await request.json();
        if (!body.ref) return err("Missing: ref", 400, origin);
        if (!body.region) return err("Missing: region", 400, origin);

        const poMatch = body.ref.match(/PO[\s\-_]*(\d+)/i);
        const id = poMatch ? `PO-${poMatch[1]}` : body.ref.trim().replace(/\s+/g, "-");

        const existing = await getAllOrders(token, sheetId);
        if (existing.find(o => o.id === id)) {
          return err(`Order ${id} already exists`, 409, origin);
        }

        const order = { id, ...body };
        let driveFolderId = "";
        let isNewSupplier = false;
        try {
          const folder = await driveCreateFolder(token, id, body.supplier || "");
          driveFolderId = folder.id;
          isNewSupplier = folder.isNewSupplier || false;
          order.driveFolderId = driveFolderId;
        } catch (e) {
          console.error("Drive folder creation failed:", e.message);
        }

        const created = await addOrder(token, sheetId, order);
        return json({ success: true, order: created, driveFolderId, isNewSupplier }, 201, origin);
      }

      // PATCH /api/orders/:id
      if (path.startsWith("/api/orders/") && method === "PATCH") {
        const orderId = decodeURIComponent(path.replace("/api/orders/", ""));
        const token = await getToken(env);
        const body = await request.json();
        const updated = await updateOrder(token, sheetId, orderId, body);
        return json({ success: true, order: updated }, 200, origin);
      }

      // DELETE /api/orders/:id
      if (path.startsWith("/api/orders/") && method === "DELETE") {
        const orderId = decodeURIComponent(path.replace("/api/orders/", ""));
        const token = await getToken(env);
        const result = await deleteOrder(token, sheetId, orderId);
        return json(result, 200, origin);
      }

      // GET /api/payments
      if (path === "/api/payments" && method === "GET") {
        const token = await getToken(env);
        const payments = await getAllPayments(token, sheetId);
        return json({ payments, count: payments.length }, 200, origin);
      }

      // POST /api/payments
      if (path === "/api/payments" && method === "POST") {
        const token = await getToken(env);
        const body = await request.json();
        if (!body.amount) return err("Missing: amount", 400, origin);

        const id = body.id || `pmt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const payment = { id, ...body };
        const created = await addPayment(token, sheetId, payment);

        if (body.orderIds?.length) {
          for (const oid of body.orderIds) {
            try {
              const updates = {};
              if (body.type === "Deposit" || body.type === "Full Amount") {
                updates.depositStatus = "paid";
                updates.depositPaid = body.date || new Date().toISOString().slice(0, 10);
              } else if (body.type === "Release") {
                updates.releaseStatus = "paid";
                updates.releasePaid = body.date || new Date().toISOString().slice(0, 10);
              }
              await updateOrder(token, sheetId, oid, updates);
            } catch (e) {
              console.error(`Failed to update order ${oid}:`, e.message);
            }
          }
        }
        return json({ success: true, payment: created }, 201, origin);
      }

      // PATCH /api/payments/:id
      if (path.startsWith("/api/payments/") && method === "PATCH") {
        const paymentId = decodeURIComponent(path.replace("/api/payments/", ""));
        const token = await getToken(env);
        const body = await request.json();
        const updated = await updatePayment(token, sheetId, paymentId, body);
        return json({ success: true, payment: updated }, 200, origin);
      }

      // DELETE /api/payments/:id
      if (path.startsWith("/api/payments/") && method === "DELETE") {
        const paymentId = decodeURIComponent(path.replace("/api/payments/", ""));
        const token = await getToken(env);
        const result = await deletePayment(token, sheetId, paymentId);
        return json(result, 200, origin);
      }

      // GET /api/drive/folders
      if (path === "/api/drive/folders" && method === "GET") {
        const token = await getToken(env);
        const folders = await driveListFolders(token);
        return json({ folders }, 200, origin);
      }

      // POST /api/drive/folders
      if (path === "/api/drive/folders" && method === "POST") {
        const token = await getToken(env);
        const body = await request.json();
        if (!body.name) return err("Missing: name", 400, origin);
        const folder = await driveCreateFolder(token, body.name, body.supplier || "");
        return json({ folder }, 201, origin);
      }

      // GET /api/drive/files/:folderId
      if (path.startsWith("/api/drive/files/") && method === "GET") {
        const folderId = path.replace("/api/drive/files/", "");
        if (!folderId) return err("Missing folderId", 400, origin);
        const token = await getToken(env);
        const files = await driveListFiles(token, folderId);
        return json({ files }, 200, origin);
      }

      // POST /api/drive/upload
      if (path === "/api/drive/upload" && method === "POST") {
        const token = await getToken(env);
        const contentType = request.headers.get("Content-Type") || "";

        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          const file = formData.get("file");
          const folderId = formData.get("folderId");
          const poRef = formData.get("poRef");
          if (!file) return err("Missing file", 400, origin);

          let targetFolderId = folderId;
          if (!targetFolderId && poRef) {
            let folder = await driveFindFolder(token, poRef);
            if (!folder) folder = await driveCreateFolder(token, poRef, "");
            targetFolderId = folder.id;

            // Update order with folder ID if missing
            try {
              const poKey = poRef.match(/PO[\s\-_]*(\d+)/i) ? `PO-${poRef.match(/PO[\s\-_]*(\d+)/i)[1]}` : poRef.trim().replace(/\s+/g, "-");
              const orders = await getAllOrders(token, sheetId);
              const order = orders.find(o => o.id === poKey || o.ref === poRef);
              if (order && !order.driveFolderId) {
                await updateOrder(token, sheetId, order.id, { driveFolderId: targetFolderId });
              }
            } catch (e) {
              console.error("Failed to update order driveFolderId:", e.message);
            }
          }
          if (!targetFolderId) return err("Missing folderId or poRef", 400, origin);

          const result = await driveUploadFile(token, {
            folderId: targetFolderId,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            body: await file.arrayBuffer(),
          });
          return json({ success: true, file: result }, 201, origin);
        }

        const body = await request.json();
        if (!body.folderId && !body.poRef) return err("Missing folderId or poRef", 400, origin);
        if (!body.fileName || !body.data) return err("Missing fileName or data", 400, origin);

        let targetFolderId = body.folderId;
        if (!targetFolderId && body.poRef) {
          let folder = await driveFindFolder(token, body.poRef);
          if (!folder) folder = await driveCreateFolder(token, body.poRef, "");
          targetFolderId = folder.id;

          // Update order with folder ID if missing
          try {
            const poKey = body.poRef.match(/PO[\s\-_]*(\d+)/i) ? `PO-${body.poRef.match(/PO[\s\-_]*(\d+)/i)[1]}` : body.poRef.trim().replace(/\s+/g, "-");
            const orders = await getAllOrders(token, sheetId);
            const order = orders.find(o => o.id === poKey || o.ref === body.poRef);
            if (order && !order.driveFolderId) {
              await updateOrder(token, sheetId, order.id, { driveFolderId: targetFolderId });
            }
          } catch (e) {
            console.error("Failed to update order driveFolderId:", e.message);
          }
        }
        const binary = atob(body.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const result = await driveUploadFile(token, {
          folderId: targetFolderId,
          fileName: body.fileName,
          mimeType: body.mimeType || "application/pdf",
          body: bytes.buffer,
        });
        return json({ success: true, file: result }, 201, origin);
      }

      // GET /api/drive/find/:poRef
      if (path.startsWith("/api/drive/find/") && method === "GET") {
        const poRef = decodeURIComponent(path.replace("/api/drive/find/", ""));
        const token = await getToken(env);
        const folder = await driveFindFolder(token, poRef);
        return json({ folder, found: !!folder }, 200, origin);
      }

      // POST /api/parse — AI document parsing via Anthropic
      if (path === "/api/parse" && method === "POST") {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return err("ANTHROPIC_API_KEY not configured", 500, origin);

        const body = await request.json();
        if (!body.data) return err("Missing: data (base64)", 400, origin);

        const mediaType = body.media_type || "application/pdf";
        const isPDF = mediaType === "application/pdf";
        const block = isPDF
          ? { type: "document", source: { type: "base64", media_type: mediaType, data: body.data } }
          : { type: "image", source: { type: "base64", media_type: mediaType, data: body.data } };

        const systemPrompt = `You are analysing a document for Bureau Booths, a company that ships booth/furniture containers from Chinese suppliers (Soundbox, Hecor, Dawon, Sunon) to AU, UK, US, and CA.
Determine the document type from: purchase_order, commercial_invoice, remittance, freight_invoice. Then extract data. Return ONLY JSON:
If purchase_order: {"doc_type":"purchase_order","supplier":"","po_reference":"","invoice_number":"","po_date":"YYYY-MM-DD","destination_region":"AU|UK|US|CA","currency":"USD|RMB","total_value":0,"deposit_amount":0,"release_amount":0,"notes":"","confidence":"high|medium|low","confidence_details":{"supplier":"high|medium|low","po_reference":"high|medium|low","po_date":"high|medium|low","total_value":"high|medium|low","destination_region":"high|medium|low","deposit_amount":"high|medium|low"}}
If remittance: {"doc_type":"remittance","bank_account_hint":"AU-NAB|UK-HSBC|US-Chase|CA-RBC","source_entity":"AU|UK|US|CA","payment_date":"YYYY-MM-DD","amount":0,"currency":"USD","po_references":[""],"payment_type":"Deposit|Release|Full Amount","reference":"","notes":"","confidence":"high|medium|low","confidence_details":{"amount":"high|medium|low","payment_date":"high|medium|low","source_entity":"high|medium|low","po_references":"high|medium|low"}}
If commercial_invoice: {"doc_type":"commercial_invoice","supplier":"","invoice_number":"","invoice_date":"","po_reference":"","destination_region":"AU|UK|US|CA","currency":"USD|RMB","total_amount":0,"notes":"","confidence":"high|medium|low","confidence_details":{"invoice_number":"high|medium|low","total_amount":"high|medium|low","po_reference":"high|medium|low"}}
If freight_invoice: {"doc_type":"freight_invoice","invoice_number":"","tracking_number":"","total_amount":0,"currency":"AUD","destination_region":"AU|UK|US|CA","po_reference":"","origin":"","destination":"","notes":"","confidence":"high|medium|low","confidence_details":{"invoice_number":"high|medium|low","total_amount":"high|medium|low","po_reference":"high|medium|low"}}
Hints: GB prefix=UK, US=US, CA=CA, AU/E=AU. Invoice prefixes: GB=UK Soundbox, HA=Hecor, BUR=Dawon.`;

        const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1200,
            system: systemPrompt,
            messages: [{ role: "user", content: [block, { type: "text", text: "Identify document type and extract data. Return ONLY JSON." }] }],
          }),
        });

        if (!anthropicRes.ok) {
          const errText = await anthropicRes.text();
          return err(`Anthropic API error (${anthropicRes.status}): ${errText}`, 502, origin);
        }

        const anthropicData = await anthropicRes.json();
        const rawText = (anthropicData.content || []).map(c => c.text || "").join("");
        try {
          const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
          return json(parsed, 200, origin);
        } catch (e) {
          return err("Failed to parse AI response: " + rawText.slice(0, 500), 502, origin);
        }
      }

      // GET /api/all — combined load
      if (path === "/api/all" && method === "GET") {
        const token = await getToken(env);
        const [orders, payments, folders] = await Promise.all([
          getAllOrders(token, sheetId),
          getAllPayments(token, sheetId),
          driveListFolders(token).catch(() => []),
        ]);
        const folderMap = {};
        folders.forEach(f => { folderMap[f.name] = f; });
        orders.forEach(o => {
          if (!o.driveFolderId) {
            const folder = folderMap[o.id];
            if (folder) { o.driveFolderId = folder.id; o.driveUrl = folder.webViewLink; }
          }
        });
        return json({
          orders, payments, folders,
          meta: { orderCount: orders.length, paymentCount: payments.length, folderCount: folders.length },
        }, 200, origin);
      }

      return err(`Not found: ${method} ${path}`, 404, origin);
    } catch (e) {
      console.error("Worker error:", e);
      return err(e.message || "Internal server error", 500, origin);
    }
  },
};
