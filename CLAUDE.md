# Bureau Ops Dashboard

## What This Project Is

An operations dashboard for Bureau Booths managing purchase orders, payments, split payments, and intercompany clearing across 4 geographic entities (AU, UK, US, CA). Bureau ships containers of booth/furniture products from Chinese suppliers to these regions.

## Architecture

```
User
    ↓ loads
index.html (Cloudflare Pages, auto-deploys from GitHub)
    ↓ /api/* (same-origin)
Pages Function proxy (functions/api/[[path]].js)
    ↓ forwards request
Cloudflare Worker (bureau.nik-d88.workers.dev)
    ↓ reads/writes
Google Sheets ("Bureau Ops Data" — the database, flat & accessible)
    +
Google Drive ("Supplier purchase orders" — document storage)
    +
Claude Haiku 4.5 (document parsing via /api/parse)
```

**Google Sheets is the database.** This is deliberate — anyone on the team can open the sheet and see/edit data directly if the dashboard breaks. The Worker is just an API layer that reads/writes the sheet cleanly.

**Google Drive stores documents.** Each PO gets a folder inside its supplier's subfolder. New supplier folders are auto-created.

**Claude Haiku 4.5 parses documents.** Upload a PO, remittance, or invoice → AI extracts structured data with confidence scores → human reviews and confirms.

### Key URLs

- **Dashboard**: `https://bureau-a04.pages.dev/` (Cloudflare Pages, auto-deploys from GitHub)
- **Worker API**: `https://bureau.nik-d88.workers.dev`
- **GitHub repo**: `https://github.com/nikb333/Bureau` (private)

### Google Sheet Structure (Worker-owned, 2 tabs)

**Orders tab** — one row per PO (columns A:T):
`ID | Region | Ref | Invoice | Supplier | Currency | Total Value | Deposit Amt | Deposit Status | Deposit Due | Deposit Paid | Release Amt | Release Status | Release Due | Release Paid | Notes | Drive Folder ID | Created | Updated | PO Date`

**Payments tab** — one row per payment (columns A:L):
`ID | Bank Account | Source Entity | Amount | Currency | Payment Date | Payment Type | Order IDs | Allocations (JSON) | Notes | Doc Name | Created`

All dates are ISO YYYY-MM-DD. No formulas, no scripts, no merged cells.

### Google Drive Structure

```
Supplier purchase orders/          ← top-level, shared with service account
  ├── Soundbox/
  │   ├── PO-191/
  │   └── PO-192/
  ├── Hecor/
  │   └── PO-204/
  ├── Dawon/
  │   └── ...
  ├── Sunon/
  │   └── ...
  └── [new suppliers auto-created on first PO]
```

## File Structure

```
Bureau/                          ← GitHub repo root
  ├── index.html                 ← THE dashboard (single file, React + Babel via CDN, ~1600 lines)
  ├── worker.js                  ← Cloudflare Worker API (auto-deploys from GitHub)
  ├── wrangler.toml              ← Worker config (name=bureau, account_id)
  ├── functions/
  │   └── api/
  │       └── [[path]].js        ← Pages Function: proxies /api/* to Worker
  ├── .github/workflows/
  │   └── deploy-worker.yml      ← GitHub Actions: auto-deploy Worker on push
  ├── bulk-mark-paid.js          ← One-off browser script: bulk mark orders as paid
  ├── mark-old-orders-paid.js    ← One-off script: mark pre-Dec 2025 orders paid (legacy)
  ├── mark-old-orders-paid-browser.js  ← Browser version of above (legacy)
  └── CLAUDE.md                  ← This file
```

The dashboard is a **single self-contained HTML file**. It loads React 18, ReactDOM, and Babel from CDNs. All components, styles, and logic are in this one file. No build step, no npm, no node_modules.

The Worker ("bureau") auto-deploys from GitHub when `worker.js` or `wrangler.toml` changes on main (via GitHub Actions).

The dashboard (index.html) auto-deploys via Cloudflare Pages connected to GitHub — no workflow needed.

## Tech Stack

- React 18 (via CDN, using Babel in-browser transform)
- Light theme UI — DM Sans for text, JetBrains Mono for numbers/amounts
- CSS custom properties for theming (all defined in `:root`)
- Cloudflare Worker for API layer (auto-deploys from GitHub)
- Google Sheets API v4 for data persistence (service account auth with JWT/RS256)
- Google Drive API v3 for document storage (per-PO folders inside supplier subfolders)
- Claude Haiku 4.5 API for document parsing (called server-side from Worker via /api/parse)
- GitHub Actions for Worker deployment

## Authentication & Access Control

The dashboard has no user-facing authentication — it is publicly accessible at the Pages URL. The only auth in the system is the **Google Service Account** used server-side by the Worker to authenticate with Google Sheets and Drive APIs (JWT/RS256 signing).

The Pages Function proxy forwards `/api/*` requests to the Worker without any additional auth headers. CORS is open (allows any origin).

### Cloudflare Worker Secrets

| Secret | Description |
|--------|-------------|
| `GOOGLE_SERVICE_ACCOUNT` | Service account JSON key (full JSON blob) |
| `SHEET_ID` | Google Sheet ID for "Bureau Ops Data" |
| `ANTHROPIC_API_KEY` | Claude API key for document parsing |

## Core Business Logic

### Entities & Bank Accounts

| Entity | Bank | Identifier |
|--------|------|------------|
| AU | NAB | au-nab |
| UK | HSBC | uk-hsbc |
| US | Chase | us-chase |
| CA | RBC | ca-rbc |

### Suppliers (Chinese manufacturers)

Soundbox, Hecor, Dawon, Sunon (new suppliers auto-create Drive folders)

### Invoice Prefix Convention

- `GB` = UK Soundbox
- `US` = US Soundbox
- `CA` = CA Soundbox
- `AU` = AU Soundbox
- `HA` = Hecor
- `BUR` = Dawon

### FX Rates (to USD)

```
RMB: 6.91, USD: 1, AUD: 0.71, CAD: 0.73, GBP: 1.37, EUR: 1.19
```

### Payment Flow

Factory POs have two payment stages:

1. **Deposit** — typically 30% of total PO value, paid upfront
2. **Release** — remaining balance, paid when goods are ready to ship

Each stage has its own status: unpaid → due → paid (with overdue detection based on due date vs today)

Some POs are "Full Amount" — single payment covering the full value.

### Line Item View

Orders are displayed as individual payment line items in the table (Deposit row, Release row, or Full Amount row), not as single order rows. This gives clearer visibility into what's been paid vs what's outstanding per payment stage.

### Split Payments

A single bank payment can cover multiple POs. The Payments tab stores `Order IDs` (comma-separated) and `Allocations` (JSON mapping order ID → amount).

### Intercompany Clearing

Auto-detected when the payment source entity ≠ the PO destination entity (e.g., UK bank paying for a US PO via TransferMate). The dashboard calculates net positions between entity pairs.

## Worker API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check (status, sheet configured flag, timestamp) |
| GET | `/api/all` | Combined load: orders + payments + Drive folders in one call |
| GET | `/api/orders` | List all orders |
| POST | `/api/orders` | Create new PO (also creates Drive folder, auto-creates supplier folder) |
| PATCH | `/api/orders/:id` | Update order fields (any subset) |
| DELETE | `/api/orders/:id` | Delete order by ID |
| GET | `/api/payments` | List all payments |
| POST | `/api/payments` | Record payment (auto-updates linked order deposit/release statuses) |
| PATCH | `/api/payments/:id` | Update payment fields (commonly used to attach docName) |
| DELETE | `/api/payments/:id` | Delete payment by ID |
| GET | `/api/drive/folders` | List all PO folders across all suppliers |
| POST | `/api/drive/folders` | Create PO folder (with optional supplier) |
| GET | `/api/drive/files/:folderId` | List files in a PO folder |
| POST | `/api/drive/upload` | Upload file (multipart form-data or JSON base64) |
| GET | `/api/drive/find/:poRef` | Find PO folder by reference |
| POST | `/api/parse` | AI document parsing via Claude Haiku 4.5 (base64 input → structured JSON) |
| POST | `/api/setup` | Create/verify sheet tabs + headers |
| POST | `/api/migrate` | One-time import from old V2 sheet (duplicate protection) |

### Payment Creation Side Effects

When `POST /api/payments` is called:
- Linked orders are automatically updated based on payment type
- Deposit → sets `depositStatus=paid`, `depositPaid=date`
- Release → sets `releaseStatus=paid`, `releasePaid=date`
- Full Amount → sets both deposit and release as paid

## App Tabs / Features

### 1. Outstanding POs Tab

- Default view — shows only unpaid/overdue payment line items
- Summary stats: line item count, total value, paid amount, outstanding amount
- Filters:
  - **Period**: 1M, 3M, 6M, 1Y, All (relative date ranges)
  - **Region**: AU, UK, US, CA, All
  - **Supplier**: Soundbox, Hecor, Dawon, Sunon, All
- Search across PO ref, invoice number, supplier, notes
- **Sortable columns**: Ref, Invoice, Supplier, Amount (USD), Due Date, PO Date (click header to sort, click again to reverse)
- Table columns: Status icon, Region badge, PO Ref, Invoice, Supplier, Type (Deposit/Release/Full), Currency, Amount, USD Equiv, Due Date, Paid Date, Drive link (📁), Edit button, Delete button
- Inline PO upload: drag-and-drop or click → AI parses → review form → confirm → saves to API + uploads to Drive

### 2. All POs Tab

- Shows all purchase orders regardless of status
- Same filters as Outstanding but adds **Status filter**: Paid, Unpaid, All
- Same sortable columns, search, and inline upload

### 3. Payments Tab

- Shows payment records (one row per payment, may span multiple POs)
- Summary stats: payment count, total paid, intercompany count
- Filters:
  - **Period**: 1M, 3M, 6M, 1Y, All
  - **Source Entity**: AU, UK, US, CA, All
- Search across PO refs, document name, notes
- **Sortable columns**: Date, Source Entity, Amount, Type
- Table columns: Date, PO ref(s), Source entity, Bank, Amount, Type, IC badge, Delete button
- Intercompany flag (⚠ IC badge) when source entity ≠ PO destination
- Inline remittance upload: drop remittance → AI parses → fuzzy matches to PO → review → confirm

### 4. Intercompany Clearing Tab

- Auto-detects IC when payment source ≠ PO destination
- Shows entity pairs with:
  - Directional flow arrows ("→ owes →" / "← owed ←")
  - Net amount calculation
  - Transaction detail table per pair (Date, PO, From, To, Amount)
- Summary: IC pair count, total exposure

### 5. Cash Forecast Tab

- Groups payment obligations by week (Monday–Sunday)
- Per-week display:
  - Date range, item count
  - Total amount, Paid, Overdue, Due amounts
  - Stacked bar chart (green=paid, red=overdue, amber=due)
  - Expandable row showing individual line items
  - Cumulative running total (Σ)

### 6. Document Upload & AI Parsing

- Drag-and-drop PDF/image upload (inline on Orders and Payments tabs)
- AI parsing via Claude Haiku 4.5 (server-side, called from Worker)
- 4 document types: Purchase Order, Commercial Invoice, Bank Remittance, Freight Invoice
- Returns structured JSON with field-level confidence scores (high/medium/low)
- Confidence-based colour coding: green=OK (high), amber=check (medium), red=fix (low)
- Human reviews pre-filled form → edits if needed → confirms → data saves to API

### 7. Smart Remittance Matching

- When uploading a remittance, fuzzy-matches to existing POs
- Scoring system: exact match > contains > partial > PO number match
- Shows top 8 candidates with score, region, outstanding balance
- Amount validation: checks parsed amount against deposit/release/full amount expectations
- Can attach to existing unpaid payments or create new payment record

### 8. Edit & Delete

- **Edit Order**: Modal to edit any order field (ref, invoice, supplier, PO date, currency, amounts, statuses, due dates, paid dates, notes)
- **Delete Order**: Confirmation dialog → removes from Google Sheet
- **Delete Payment**: Confirmation dialog → removes from Google Sheet
- Changes persist immediately via PATCH/DELETE API calls

### 9. Help Modal

- In-app backend architecture guide
- Google Sheets database structure explanation
- Google Drive storage structure
- Worker API health check
- Troubleshooting tips
- Service account access info

## Google Cloud Setup

- Service account JSON key stored as Cloudflare Worker secret: `GOOGLE_SERVICE_ACCOUNT`
- Required APIs enabled: Google Sheets API, Google Drive API
- Service account email must have Editor access on both the Sheet and the "Supplier purchase orders" Drive folder
- Auth uses JWT/RS256 signing via Web Crypto API (no external libraries)

## Deployment & Change Workflow

### Dashboard (index.html)

1. Edit `index.html`
2. `git add index.html && git commit -m "description" && git push`
3. Cloudflare Pages auto-deploys from GitHub in ~30 seconds

### Worker (worker.js)

1. Edit `worker.js`
2. `git add worker.js && git commit -m "description" && git push`
3. GitHub Actions triggers `deploy-worker.yml` → deploys via Wrangler

### GitHub Actions

- `.github/workflows/deploy-worker.yml` — triggers on push to main when `worker.js` or `wrangler.toml` changes
- Uses `cloudflare/wrangler-action@v3` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets

## Code Style & Preferences

- Single-file HTML architecture (all React components, CSS, and logic in index.html)
- Functional React components with hooks (useState, useRef, useMemo, useEffect, useCallback — no class components)
- Light theme with clean, professional aesthetic
- CSS custom properties defined in `:root` (--bg, --ac, --gn, --am, --rd, etc.)
- DM Sans for UI text, JetBrains Mono for financial figures
- All currency displayed in USD: `$X,XXX.XX` format (use toLocaleString)
- All dates stored as ISO `YYYY-MM-DD`, displayed as `DD MMM YYYY` (en-GB)
- Status badges: green=paid, amber=due, red=overdue, grey=unpaid
- Region badges: AU=amber, UK=blue, US=red, CA=green
- Handle errors gracefully — show user-friendly messages, error screen with retry
- No localStorage (not supported in Claude artifacts)
- Responsive layout: sidebar collapses at 900px breakpoint

## Key React Components

| Component | Purpose |
|-----------|---------|
| `App` | Root — loads data via /api/all, manages tab state, renders sidebar + active tab |
| `OrdersTab` | Renders Outstanding POs or All POs (controlled by `outstanding` prop) |
| `PaymentsTab` | Payment ledger with IC detection |
| `IntercompanyTab` | Net position calculator between entity pairs |
| `ForecastTab` | Weekly cash forecast with progress bars |
| `InlineUploader` | Drag-drop upload → AI parse → review → save (used in Orders and Payments tabs) |
| `ReviewScreen` | Displays parsed document data for field-by-field review before save |
| `EditOrderModal` | Modal form to edit any order field |
| `HelpModal` | In-app backend architecture guide |

## Key Utility Functions

| Function | Purpose |
|----------|---------|
| `toUSD(amount, currency)` | Converts any currency to USD using FX rates |
| `usd(n)` | Formats number as `$X,XXX.XX` |
| `fmtDate(iso)` | Formats ISO date as `DD MMM YYYY` |
| `ordersToLineItems(orders)` | Splits orders into Deposit/Release/Full Amount rows |
| `fuzzyMatchPO(input, orders)` | Fuzzy search POs by ref/invoice with scoring |
| `fuzzyMatchPayment(parsed, payments)` | Matches remittances to existing payments (±5% amount, ±7 day tolerance) |
| `parseDoc(file)` | Converts file to base64 and calls /api/parse |
| `apiGet/apiPost/apiPatch/apiDelete` | API request wrappers |

## Data Migration

- The old V2 Google Sheet has been migrated — 267 orders and 373 payments imported
- Migration endpoint: `POST /api/migrate` — reads from 4 regional tabs (AU/UK/US/CA Stock Orders)
- Duplicate protection built in (checks if orders exist before importing)
- Migration only runs once — the endpoint rejects if orders already present
- Utility scripts (`bulk-mark-paid.js`, `mark-old-orders-paid*.js`) were one-off cleanup tools used during migration

## Important Notes

- Never hardcode API keys — use Cloudflare Worker secrets
- Split payments are a core feature — allocations JSON handles many-to-many PO ↔ payment relationships
- Intercompany clearing is auto-detected, not manually flagged
- Document AI parsing costs ~$0.003/doc via Haiku — no need to rate-limit
- Dashboard is primarily desktop but works on tablet (responsive at 900px)
- Team members: Nik, Sam, Teya
- The Worker handles CORS for all responses (allows GET/POST/PATCH/PUT/DELETE/OPTIONS)
- All Google API calls go through an authenticated `gfetch()` wrapper with auto-token caching
