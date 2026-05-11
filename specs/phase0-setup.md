# RiskGuard — Shared Project Setup & Conventions

> **IMPORTANT**: Read this file FIRST before any phase file. It contains the tech stack, project structure, and conventions that apply to ALL phases.

---

## Product Context

- **Product**: RiskGuard
- **Company**: MetroPay
- **Purpose**: Internal credit risk and underwriting platform
- **Integrates with**: PayFlow (disbursement + repayment), ComplyHub (stubbed)
- **Currency**: SimCash (SIM) — same as PayFlow

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ with TypeScript |
| Framework | Express.js with `express-async-errors` |
| Database | SQLite via `better-sqlite3` |
| Migrations | Custom migration runner |
| Auth | API key-based (header: `X-API-Key`) |
| Validation | `zod` |
| Logging | `pino` |
| Testing | `vitest` + `supertest` |
| UUID | `uuid` package |
| HTTP client | `undici` (for PayFlow API calls) |

---

## Server Port

RiskGuard runs on port **3001** (PayFlow uses 3000).

---

## Project Structure

```
riskguard/
├── package.json
├── tsconfig.json
├── .env.example
├── data/
│   ├── riskguard.db
│   └── riskguard-test.db
├── migrations/
│   ├── 001_borrowers_scoring.sql
│   ├── 002_loan_origination.sql
│   ├── 003_disbursement_repayment.sql
│   ├── 004_collections.sql
│   └── 005_portfolio_reporting.sql
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── db.ts
│   ├── migrate.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   ├── idempotency.ts
│   │   ├── error-handler.ts
│   │   └── request-logger.ts
│   ├── routes/
│   │   ├── borrowers.ts
│   │   ├── loans.ts
│   │   ├── disbursements.ts
│   │   ├── collections.ts
│   │   └── reports.ts
│   ├── services/
│   │   ├── scoring.service.ts
│   │   ├── underwriting.service.ts
│   │   ├── emi.service.ts
│   │   ├── disbursement.service.ts
│   │   ├── collections.service.ts
│   │   ├── reporting.service.ts
│   │   ├── payflow.service.ts
│   │   └── complyhub-stub.service.ts
│   ├── workers/
│   │   ├── repayment-executor.ts
│   │   └── dpd-tracker.ts
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       ├── currency.ts
│       ├── pagination.ts
│       └── date.ts
├── tests/
│   ├── setup.ts
│   ├── scoring.test.ts
│   ├── underwriting.test.ts
│   ├── disbursement.test.ts
│   ├── collections.test.ts
│   └── reporting.test.ts
└── seed/
    └── seed.ts
```

---

## Dependencies

```bash
npm init -y
npm install express express-async-errors better-sqlite3 zod pino pino-http dotenv uuid undici
npm install -D typescript tsx @types/express @types/better-sqlite3 @types/uuid vitest supertest @types/supertest
```

---

## Database Setup (src/db.ts)

```typescript
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'riskguard.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;
```

**Key SQLite conventions:**
- `better-sqlite3` is synchronous — use `db.prepare(sql).run()`, `.get()`, `.all()` (no `await`).
- Transactions: `db.transaction(() => { ... })()`.
- `TEXT` for UUIDs (generated in app with `uuid` package).
- `TEXT` for timestamps (store ISO 8601 strings).
- `INTEGER` for money (64-bit, store paise).
- `TEXT` for JSON (parse/stringify in app).
- `TEXT` for arrays (JSON-encoded).

---

## Migration Runner (src/migrate.ts)

```typescript
import fs from 'fs';
import path from 'path';
import db from './db';

export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      console.log(`Migration applied: ${file}`);
    }
  }
}
```

---

## Global Conventions

### API Response Format

```json
// Success
{
  "success": true,
  "data": { ... },
  "meta": { "page": 1, "limit": 10, "total": 42 }
}

// Error
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_CREDIT_LIMIT",
    "message": "Loan amount exceeds available credit limit",
    "details": { "available": "75000.00", "requested": "100000.00" }
  }
}
```

### Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `VALIDATION_ERROR` | 400 | Request body/params failed zod validation |
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Valid key but insufficient permissions |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `CONFLICT` | 409 | Duplicate or conflicting state |
| `INSUFFICIENT_CREDIT_LIMIT` | 422 | Amount exceeds available limit |
| `LOAN_NOT_DISBURSED` | 422 | Action requires disbursed loan |
| `INVALID_STATE` | 422 | Action not valid for current state |
| `KYC_FAILED` | 422 | ComplyHub KYC check failed (stub always passes) |
| `RATE_LIMITED` | 429 | Too many requests |
| `PAYFLOW_ERROR` | 502 | Upstream PayFlow API failed |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### Idempotency

All `POST` and `PATCH` endpoints accept an `Idempotency-Key` header. Same logic as PayFlow:
1. Hash `(idempotency_key, endpoint, api_key)`.
2. If matching record exists with same payload → return cached response.
3. If matching record with different payload → return 409.
4. Otherwise process and cache.

### Money Handling

All amounts stored as `INTEGER` (paise: 1 SIM = 100 paise). API accepts/returns strings with 2 decimals: `"15000.00"`. Internal storage: `1500000` paise.

### Timestamps

Store as `TEXT` ISO 8601 strings (e.g., `2025-03-15T10:00:00.000Z`).

---

## Authentication

API key in `X-API-Key` header. The borrowers table stores users (employees) seeded at startup. Roles:
- `employee` — can apply for loans, view own data
- `underwriter` — can approve/reject applications within their tier
- `senior_underwriter` — can approve committee-tier applications
- `collections_agent` — can manage collections queue
- `admin` — full access including write-offs and manual score adjustments

---

## PayFlow Integration

**Base URL:** Configurable via `PAYFLOW_BASE_URL` (default: `http://localhost:3000`)

**Auth:** RiskGuard has its own dedicated API key in PayFlow stored as `PAYFLOW_API_KEY` env var.

**Lending wallet:** RiskGuard maintains a master "lending wallet" in PayFlow. Disbursements transfer from this wallet to borrower wallets. Repayments transfer back.

**Service module:** `src/services/payflow.service.ts` wraps all PayFlow calls.

```typescript
// src/services/payflow.service.ts
import { request } from 'undici';

const PAYFLOW_BASE = process.env.PAYFLOW_BASE_URL || 'http://localhost:3000';
const PAYFLOW_KEY = process.env.PAYFLOW_API_KEY!;
const LENDING_WALLET_ID = process.env.LENDING_WALLET_ID!;

export async function transferFromPayFlow(params: {
  fromWalletId: string;
  toWalletId: string;
  amount: string;
  description: string;
  idempotencyKey: string;
}) {
  const res = await request(`${PAYFLOW_BASE}/api/v1/transfers`, {
    method: 'POST',
    headers: {
      'X-API-Key': PAYFLOW_KEY,
      'Idempotency-Key': params.idempotencyKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender_wallet_id: params.fromWalletId,
      receiver_wallet_id: params.toWalletId,
      amount: params.amount,
      description: params.description,
    }),
  });
  const body = await res.body.json();
  if (res.statusCode >= 400) throw new Error(`PayFlow error: ${JSON.stringify(body)}`);
  return body;
}

export async function getWalletBalance(walletId: string) {
  const res = await request(`${PAYFLOW_BASE}/api/v1/wallets/${walletId}`, {
    method: 'GET',
    headers: { 'X-API-Key': PAYFLOW_KEY },
  });
  return res.body.json();
}
```

**Important:** If PayFlow is not running, RiskGuard endpoints that call PayFlow should return `PAYFLOW_ERROR` (502). Do NOT mock these calls — they must hit the actual PayFlow service.

---

## ComplyHub Integration (Stubbed)

Real ComplyHub doesn't exist yet. Use stubs in `src/services/complyhub-stub.service.ts`:

```typescript
// src/services/complyhub-stub.service.ts
export async function checkKyc(borrowerId: string) {
  // STUB: always passes. Replace when ComplyHub is built.
  return { status: 'passed' as const, verified_at: new Date().toISOString() };
}

export async function screenAml(transactionId: string, amount: string) {
  // STUB: never flags. Replace when ComplyHub is built.
  return { flagged: false };
}

export async function logAuditEvent(event: object) {
  // STUB: no-op. Replace when ComplyHub is built.
  return { status: 'ok' };
}
```

---

## .env.example

```bash
NODE_ENV=development
PORT=3001
LOG_LEVEL=debug
DATABASE_PATH=./data/riskguard.db

# PayFlow integration
PAYFLOW_BASE_URL=http://localhost:3000
PAYFLOW_API_KEY=pfk_riskguard_service_key
LENDING_WALLET_ID=<seeded-on-first-run>
```

---

## npm Scripts

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "migrate": "tsx src/migrate.ts",
    "seed": "tsx seed/seed.ts",
    "test": "vitest",
    "worker:repayment": "tsx src/workers/repayment-executor.ts",
    "worker:dpd": "tsx src/workers/dpd-tracker.ts"
  }
}
```

---

## Known Bugs Notice

This project contains **intentional bugs** for QA training purposes. Each bug is marked with a comment like `// BUG RG-XXX`. These MUST be implemented exactly as specified in each phase file. Do NOT fix them. Do NOT add warnings about them beyond the inline comment.

---

## Cross-Phase Conventions

1. **Every state-changing endpoint must write to an audit trail** (using ComplyHub stub `logAuditEvent`).
2. **Every monetary calculation uses integer paise** — never floats, except where a bug is intentionally introduced.
3. **Every PayFlow call uses an idempotency key** — typically `${entity_type}-${entity_id}-${action}-${timestamp_or_attempt}`.
4. **Every loan state change is recorded** with `previous_status`, `new_status`, `changed_by`, `changed_at`, `reason`.
5. **Date arithmetic uses UTC by default** unless a phase specifically calls for IST handling (and that's where a bug lives).
