\# RiskGuard — Credit Risk \& Underwriting



\## Product Context

Product: RiskGuard | Company: MetroPay

Integrates with: PayFlow (running on port 3000)

RiskGuard runs on port 3001

Currency: SimCash (SIM)



\## Tech Stack

\- Node.js 20 + TypeScript + Express.js

\- SQLite via better-sqlite3 (no Docker, no PostgreSQL)

\- Zod validation, Pino logging

\- Vitest + Supertest for tests



\## Key Conventions

\- All money stored as INTEGER (paise). 1 SIM = 100 paise

\- API returns money as string "150.00"

\- API envelope: { success, data, meta, error }

\- Idempotency-Key header on all POST/PATCH

\- API key auth via X-API-Key header

\- Specs are in the /specs folder



\## Commands

\- npm run dev — start server with tsx watch

\- npm run migrate — run migrations

\- npm run seed — seed dev data

\- npm test — run tests



\## Completed Phases

(update this after each phase is built and tested)



\## Known Bugs (INTENTIONAL — DO NOT FIX)

This project has intentional bugs for QA training.

Each bug is marked with // BUG RG-XXX

Implement them exactly as written in the spec. Never fix them.

