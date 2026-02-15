# Bureau Ops Dashboard

## What This Project Is

An operations dashboard for Bureau Booths managing purchase orders, payments, split payments, and intercompany clearing across 4 geographic entities (AU, UK, US, CA). Bureau ships containers of booth/furniture products from Chinese suppliers to these regions.

## Architecture

```
index.html (Cloudflare Pages, auto-deploys from GitHub)
    ↓ API calls
Cloudflare Worker (bureau.nik-d88.workers.dev)
    ↓ reads/writes
Google Sheets ("Bureau Ops Data" — the database, flat & accessible)
    +
Google Drive ("Supplier purchase orders" — document storage)
```

**Google Sheets is the database.** This is deliberate — anyone on the team can open the sheet and see/edit data directly if the dashboard breaks. The Worker is just an API layer that reads/writes the sheet cleanly.

**Google Drive stores documents.** Each PO gets a folder inside its supplier's subfolder. New supplier folders are auto-created.

### Key URLs

- **Dashboard**: deployed on Cloudflare Pages (connected to GitHub repo `nikb333/Bureau`)
- **Worker API**: `https://bureau.nik-d88.workers.dev`
- **GitHub repo**: `https://github.com/nikb333/Bureau` (private)

### Google Sheet Structure (Worker-owned, 2 tabs)

**Orders tab** — one row per PO:
`ID | Region | Ref | Invoice | Supplier | Currency | Total Value | Deposit Amt | Deposit Status | Deposit Due | Deposit Paid | Release Amt | Release Status | Release Due | Release Paid | Notes | Drive Folder ID | Created | Updated`

**Payments tab** — one row per payment:
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
  └── [new suppliers auto-created]
```

## File Structure

```
Bureau/                  ← GitHub repo root
  ├── index.html         ← THE dashboard (single file, React + Babel via CDN)
  ├── worker.js          ← Worker source (auto-deploys from GitHub)
  ├── wrangler.toml      ← Worker config
  ├── .github/workflows/ ← GitHub Actions (Worker deploy)
  └── CLAUDE.md          ← This file
```

The dashboard is a **single self-contained HTML file**. It loads React 18, ReactDOM, and Babel from CDNs. All components, styles, and logic are in this one file. No build step, no npm, no node_modules.

The Worker ("bureau") is connected to GitHub and auto-deploys when code is pushed to main.

## Tech Stack

- React 18 (via CDN, using Babel in-browser transform)
- Light theme UI — DM Sans for text, JetBrains Mono for numbers/amounts
- Cloudflare Worker for API layer (auto-deploys from GitHub)
- Google Sheets API for data persistence (service account auth with JWT)
- Google Drive API for document storage (per-PO folders inside supplier subfolders)
- Claude Haiku 4.5 API for document parsing (called from Worker via /api/parse)

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

### Split Payments

A single bank payment can cover multiple POs. The Payments tab stores `Order IDs` (comma-separated) and `Allocations` (JSON mapping order ID → amount).

### Intercompany Clearing

Auto-detected when the payment source entity ≠ the PO destination entity (e.g., UK bank paying for a US PO via TransferMate). The dashboard calculates net positions between entity pairs.

## Worker API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/all` | Load orders + payments + Drive folders in one call |
| GET | `/api/orders` | List all orders |
| POST | `/api/orders` | Create new PO (also creates Drive folder) |
| PATCH | `/api/orders/:id` | Update order fields |
| GET | `/api/payments` | List all payments |
| POST | `/api/payments` | Record payment (auto-updates linked order statuses) |
| GET | `/api/drive/folders` | List all PO folders |
| POST | `/api/drive/folders` | Create PO folder |
| GET | `/api/drive/files/:folderId` | List files in folder |
| POST | `/api/drive/upload` | Upload file (multipart or base64) |
| GET | `/api/drive/find/:poRef` | Find folder by PO ref |
| POST | `/api/setup` | Create sheet tabs + headers |
| POST | `/api/migrate` | One-time import from old V2 sheet |

## App Tabs / Features

### 1. Purchase Orders Tab

- Summary stats: order count, total value, paid, outstanding
- Filterable by region, supplier, status (outstanding/paid/overdue)
- Searchable by PO ref, invoice, supplier
- Column sorting (ref, total, due date)
- Status badges auto-detect overdue based on due dates
- Drive folder link per PO (📁 icon)
- Inline upload: drop a PO document → AI parses → review → confirm → saves to API + uploads to Drive

### 2. Payments Tab

- Summary stats: payment count, total paid, intercompany count
- Filterable by source entity
- Searchable
- Intercompany flag (⚠ IC badge) when source ≠ destination
- Inline upload: drop a remittance → AI parses → fuzzy matches to PO → review → confirm

### 3. Intercompany Clearing Tab

- Auto-calculates net positions between entity pairs
- Shows direction (who owes whom) and net amount
- Transaction detail table per pair

### 4. Cash Forecast Tab

- Weekly breakdown of payment obligations
- Paid/due/overdue progress bars per week
- Expandable week rows showing individual items
- Cumulative running total (Σ)

### 5. Document Upload & AI Parsing

- Drag-and-drop PDF/image upload
- AI parsing via Claude Haiku 4.5 (4 document types: Purchase Order, Commercial Invoice, Bank Remittance, Freight Invoice)
- Returns structured JSON with field-level confidence scores
- Fuzzy PO matching for remittances — scoring system ranking candidates
- Confidence-based colour coding (green=OK, amber=check, red=fix)
- Human reviews pre-filled form → confirms → data saves to API

## Google Cloud Setup

- Service account JSON key stored as Cloudflare Worker secret: `GOOGLE_SERVICE_ACCOUNT`
- Sheet ID stored as Worker secret: `SHEET_ID`
- Required APIs enabled: Google Sheets API, Google Drive API
- Service account email must have Editor access on the Sheet and "Supplier purchase orders" Drive folder

## Deployment & Change Workflow

### Dashboard (index.html)

1. Edit `index.html` (via Claude Code or manually)
2. `git add . && git commit -m "description" && git push`
3. Cloudflare Pages auto-deploys from GitHub in ~30 seconds

### Worker (worker.js)

1. Edit `worker.js`
2. `git add . && git commit -m "description" && git push`
3. Worker auto-deploys from GitHub (connected to "bureau" Worker)

### Using Claude Code

```bash
cd C:\Users\nikb3\Bureau
claude
```

Then describe changes in plain English. Claude Code edits the files. Push to deploy.

## Code Style & Preferences

- Single-file HTML architecture (all React components, CSS, and logic in index.html)
- Functional React components with hooks (no class components)
- Light theme with clean, professional aesthetic
- DM Sans for UI text, JetBrains Mono for financial figures
- All currency displayed in USD: `$X,XXX.XX` format (use toLocaleString)
- All dates stored as ISO `YYYY-MM-DD`, displayed as `DD MMM YYYY` (en-GB)
- Status badges: green=paid, amber=due, red=overdue
- Region badges: AU=amber, UK=blue, US=red, CA=green
- Handle errors gracefully — show user-friendly messages
- No localStorage (not supported in Claude artifacts)

## Important Notes

- The old V2 Google Sheet has been migrated — 267 orders and 373 payments imported
- Migration only runs once (duplicate protection built in)
- Never hardcode API keys — use Cloudflare Worker secrets
- Split payments are a core feature — allocations JSON handles many-to-many
- Intercompany clearing is auto-detected, not manually flagged
- Document AI parsing costs ~$0.003/doc via Haiku — no need to rate-limit
- Dashboard is primarily desktop but should work on tablet
- Team members: Nik, Sam, Teya
