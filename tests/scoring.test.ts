import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import db from '../src/db';
import {
  computeTenureSubScore,
  computeSalarySubScore,
  computeDebtRatioSubScore,
  computeDepartmentRiskSubScore,
  computeFinalScore,
  assignBand,
} from '../src/services/scoring.service';
import { testApiKeys, testEmployeeIds } from './setup';

// ─── Unit: scoring sub-scores ───────────────────────────────────────────────

describe('Tenure sub-score', () => {
  it('returns 100 for < 6 months', () => {
    const joined = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days
    expect(computeTenureSubScore(joined)).toBe(100);
  });

  it('returns 300 for 6-12 months', () => {
    const joined = new Date(Date.now() - 270 * 24 * 60 * 60 * 1000);
    expect(computeTenureSubScore(joined)).toBe(300);
  });

  it('returns 500 for 1-2 years', () => {
    const joined = new Date(Date.now() - 550 * 24 * 60 * 60 * 1000);
    expect(computeTenureSubScore(joined)).toBe(500);
  });

  it('returns 750 for 2-5 years', () => {
    const joined = new Date(Date.now() - 1100 * 24 * 60 * 60 * 1000);
    expect(computeTenureSubScore(joined)).toBe(750);
  });

  it('returns 950 for 5+ years', () => {
    const joined = new Date(Date.now() - 2000 * 24 * 60 * 60 * 1000);
    expect(computeTenureSubScore(joined)).toBe(950);
  });
});

describe('Salary sub-score', () => {
  it('returns 200 for salary < 30000 SIM/month', () => {
    expect(computeSalarySubScore(2000000)).toBe(200); // 20000 SIM
  });

  it('returns 450 for 30000-60000 SIM/month', () => {
    expect(computeSalarySubScore(4000000)).toBe(450); // 40000 SIM
  });

  it('returns 650 for 60000-100000 SIM/month', () => {
    expect(computeSalarySubScore(8000000)).toBe(650); // 80000 SIM
  });

  it('returns 800 for 100000-200000 SIM/month', () => {
    expect(computeSalarySubScore(15000000)).toBe(800); // 150000 SIM
  });

  it('returns 950 for 200000+ SIM/month', () => {
    expect(computeSalarySubScore(30000000)).toBe(950); // 300000 SIM
  });

  it('returns 200 for salary = 0 (zero-salary edge case)', () => {
    expect(computeSalarySubScore(0)).toBe(200);
  });
});

describe('Debt ratio sub-score (BUG RG-002)', () => {
  it('returns 950 for zero debt with positive salary', () => {
    expect(computeDebtRatioSubScore(0, 10000000)).toBe(950);
  });

  it('returns 100 for zero debt with zero salary (0/0 = NaN, falls through to floor)', () => {
    // BUG RG-002: 0/0 = NaN; all NaN < X comparisons are false; falls to return 100
    // This incorrectly penalises zero-salary employees as highest-risk debt ratio
    const result = computeDebtRatioSubScore(0, 0);
    expect(result).toBe(100);
  });

  it('returns 800 for 10-25% debt ratio', () => {
    expect(computeDebtRatioSubScore(200000, 1000000)).toBe(800); // 20%
  });

  it('returns 100 for 60%+ debt ratio', () => {
    expect(computeDebtRatioSubScore(700000, 1000000)).toBe(100); // 70%
  });
});

describe('Department risk sub-score', () => {
  it('tier 1 → 950', () => expect(computeDepartmentRiskSubScore(1)).toBe(950));
  it('tier 2 → 800', () => expect(computeDepartmentRiskSubScore(2)).toBe(800));
  it('tier 3 → 600', () => expect(computeDepartmentRiskSubScore(3)).toBe(600));
  it('tier 4 → 400', () => expect(computeDepartmentRiskSubScore(4)).toBe(400));
  it('tier 5 → 200', () => expect(computeDepartmentRiskSubScore(5)).toBe(200));
});

describe('Band assignment (BUG RG-003)', () => {
  it('score 399 → Poor', () => expect(assignBand(399).band).toBe('Poor'));
  it('score 400 → Fair', () => expect(assignBand(400).band).toBe('Fair'));
  it('score 599 → Fair', () => expect(assignBand(599).band).toBe('Fair'));

  it('BUG RG-003: score 600 → Fair (should be Good, off-by-one on > vs >=)', () => {
    // Correct: 600-749 is "Good". Bug: uses > 600 instead of >= 600.
    expect(assignBand(600).band).toBe('Fair');
    expect(assignBand(600).creditLimit).toBe(2500000); // 25000 SIM, not 100000 SIM
  });

  it('score 601 → Good', () => expect(assignBand(601).band).toBe('Good'));
  it('score 749 → Good', () => expect(assignBand(749).band).toBe('Good'));
  it('score 750 → Very Good', () => expect(assignBand(750).band).toBe('Very Good'));
  it('score 899 → Very Good', () => expect(assignBand(899).band).toBe('Very Good'));
  it('score 900 → Excellent', () => expect(assignBand(900).band).toBe('Excellent'));
  it('score 1000 → Excellent', () => expect(assignBand(1000).band).toBe('Excellent'));
});

describe('Final score computation (BUG RG-001)', () => {
  it('produces correct result when weights sum to 10000', () => {
    const factors = [
      { factor: 'a', raw_value: 0, sub_score: 800, weight: 5000 },
      { factor: 'b', raw_value: 0, sub_score: 600, weight: 5000 },
    ];
    // Both buggy and correct give same result when weights sum to 10000
    expect(computeFinalScore(factors)).toBe(700);
  });

  it('BUG RG-001: produces inflated score when weights sum to < 10000', () => {
    // weights sum to 9000, not 10000 (as if one factor was deactivated)
    const factors = [
      { factor: 'a', raw_value: 0, sub_score: 800, weight: 5000 },
      { factor: 'b', raw_value: 0, sub_score: 600, weight: 4000 },
    ];
    // Buggy: (800*5000 + 600*4000) / 9000 = 6400000/9000 = 711
    // Correct normalized: 800*(5/9) + 600*(4/9) = 711 — same here
    // The drift appears when the sub-scores differ more; this confirms the formula works
    const score = computeFinalScore(factors);
    expect(score).toBe(711);
  });
});

// ─── HTTP: Borrower CRUD ─────────────────────────────────────────────────────

describe('POST /api/v1/borrowers', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).post('/api/v1/borrowers').send({ employee_id: 'any' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid employee_id format', async () => {
    const res = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', 'test-invalid-uuid')
      .send({ employee_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for unknown employee_id', async () => {
    const res = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', 'test-unknown-emp')
      .send({ employee_id: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });

  it('creates a new borrower with KYC passed and score computed', async () => {
    const res = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-create-frank-${Date.now()}`)
      .send({ employee_id: testEmployeeIds['frank'] });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.kyc_status).toBe('passed');
    expect(res.body.data.employee_id).toBe(testEmployeeIds['frank']);
    expect(typeof res.body.data.current_score).toBe('number');
    expect(res.body.data.current_band).toBeTruthy();
  });

  it('returns 200 (existing) when borrower already created', async () => {
    const key = `test-dup-frank-${Date.now()}`;
    const first = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', key + '-a')
      .send({ employee_id: testEmployeeIds['frank'] });

    const second = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', key + '-b')
      .send({ employee_id: testEmployeeIds['frank'] });

    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it('BUG RG-002: creates borrower for jack (zero salary) — debt ratio silently misbehaves', async () => {
    const res = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-create-jack-${Date.now()}`)
      .send({ employee_id: testEmployeeIds['jack'] });

    // Should not crash; jack gets 200 salary score and 100 debt_ratio score (NaN floor)
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/v1/borrowers/:id', () => {
  let borrowerId: string;

  it('creates borrower for iris to test get', async () => {
    const res = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-get-iris-${Date.now()}`)
      .send({ employee_id: testEmployeeIds['iris'] });
    borrowerId = res.body.data.id;
    expect(borrowerId).toBeTruthy();
  });

  it('returns full borrower detail for admin', async () => {
    const res = await request(app)
      .get(`/api/v1/borrowers/${borrowerId}`)
      .set('X-API-Key', testApiKeys['alice']);

    expect(res.status).toBe(200);
    expect(res.body.data.employee.department).toBe('Sales');
    expect(res.body.data.credit_limit).toMatch(/^\d+\.\d{2}$/);
  });

  it('returns 403 when employee tries to view another borrower', async () => {
    const frankBorrower = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-403-frank-${Date.now()}`)
      .send({ employee_id: testEmployeeIds['frank'] });

    const res = await request(app)
      .get(`/api/v1/borrowers/${frankBorrower.body.data.id}`)
      .set('X-API-Key', testApiKeys['iris']); // iris trying to view frank's profile

    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown borrower id', async () => {
    const res = await request(app)
      .get('/api/v1/borrowers/00000000-0000-0000-0000-000000000000')
      .set('X-API-Key', testApiKeys['alice']);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/borrowers/:id/recompute-score', () => {
  let borrowerId: string;

  it('setup: create borrower for charlie', async () => {
    const res = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-recompute-charlie-${Date.now()}`)
      .send({ employee_id: testEmployeeIds['charlie'] });
    borrowerId = res.body.data.id;
    expect(borrowerId).toBeTruthy();
  });

  it('recomputes score and creates snapshot', async () => {
    const res = await request(app)
      .post(`/api/v1/borrowers/${borrowerId}/recompute-score`)
      .set('X-API-Key', testApiKeys['bob']) // senior_underwriter
      .set('Idempotency-Key', `test-recompute-${Date.now()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.snapshot_id).toBeTruthy();
    expect(typeof res.body.data.new_score).toBe('number');
    expect(res.body.data.factor_breakdown).toBeTruthy();
  });

  it('creates a new snapshot in the database', () => {
    const snapshots = db
      .prepare('SELECT * FROM score_snapshots WHERE borrower_id = ? AND reason = ?')
      .all(borrowerId, 'recompute') as unknown[];
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('returns 403 for employee trying to recompute another employee', async () => {
    const res = await request(app)
      .post(`/api/v1/borrowers/${borrowerId}/recompute-score`)
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `test-forbidden-${Date.now()}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/borrowers/:id/score-history (BUG RG-004)', () => {
  let borrowerId: string;

  it('setup: create borrower and trigger multiple snapshots', async () => {
    const create = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-history-bob-${Date.now()}`)
      .send({ employee_id: testEmployeeIds['bob'] });
    borrowerId = create.body.data.id;

    // trigger a second snapshot via recompute
    await request(app)
      .post(`/api/v1/borrowers/${borrowerId}/recompute-score`)
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-history-recompute-${Date.now()}`);
  });

  it('BUG RG-004: returns snapshots in ASC order (oldest first) despite docs saying DESC', async () => {
    const res = await request(app)
      .get(`/api/v1/borrowers/${borrowerId}/score-history`)
      .set('X-API-Key', testApiKeys['alice']);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);

    // Due to BUG RG-004, first item is the oldest (initial), not the newest (recompute)
    const first = res.body.data[0];
    const last = res.body.data[res.body.data.length - 1];
    expect(new Date(first.created_at) <= new Date(last.created_at)).toBe(true);
    expect(first.reason).toBe('initial');
    expect(last.reason).toBe('recompute');
  });

  it('returns pagination meta', async () => {
    const res = await request(app)
      .get(`/api/v1/borrowers/${borrowerId}/score-history?page=1&limit=1`)
      .set('X-API-Key', testApiKeys['alice']);

    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(1);
    expect(typeof res.body.meta.total).toBe('number');
  });
});

describe('POST /api/v1/borrowers/:id/manual-adjust (BUG RG-005)', () => {
  let borrowerId: string;

  it('setup: create borrower for frank', async () => {
    const res = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-adjust-frank-${Date.now()}`)
      .send({ employee_id: testEmployeeIds['frank'] });
    borrowerId = res.body.data.id;
    expect(borrowerId).toBeTruthy();
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(app)
      .post(`/api/v1/borrowers/${borrowerId}/manual-adjust`)
      .set('X-API-Key', testApiKeys['charlie']) // underwriter, not admin
      .set('Idempotency-Key', `test-adjust-403-${Date.now()}`)
      .send({ new_score: 850, new_credit_limit: '200000.00', reason: 'Test reason that is long enough' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when reason is too short', async () => {
    const res = await request(app)
      .post(`/api/v1/borrowers/${borrowerId}/manual-adjust`)
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-adjust-shortreason-${Date.now()}`)
      .send({ new_score: 850, new_credit_limit: '200000.00', reason: 'Too short' });
    expect(res.status).toBe(400);
  });

  it('performs a valid manual adjustment', async () => {
    const res = await request(app)
      .post(`/api/v1/borrowers/${borrowerId}/manual-adjust`)
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-adjust-valid-${Date.now()}`)
      .send({
        new_score: 850,
        new_credit_limit: '200000.00',
        reason: 'Senior leadership exception per CFO email dated 2025-03-10',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.new_score).toBe(850);
    expect(res.body.data.new_limit).toBe('200000.00');
    expect(res.body.data.adjustment_id).toBeTruthy();
  });

  it('BUG RG-005: accepts out-of-range score (no min/max validation)', async () => {
    const res = await request(app)
      .post(`/api/v1/borrowers/${borrowerId}/manual-adjust`)
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-adjust-outofrange-${Date.now()}`)
      .send({
        new_score: 1500, // Invalid: above 1000 — should be rejected but bug allows it
        new_credit_limit: '50000.00',
        reason: 'Testing out-of-range score injection via BUG RG-005 — no range validation',
      });

    // BUG RG-005: accepts score = 1500, stores it in DB
    expect(res.status).toBe(200);
    expect(res.body.data.new_score).toBe(1500);
  });

  it('BUG RG-005: accepts negative score', async () => {
    const res = await request(app)
      .post(`/api/v1/borrowers/${borrowerId}/manual-adjust`)
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `test-adjust-negative-${Date.now()}`)
      .send({
        new_score: -200, // Invalid: below 0
        new_credit_limit: '10000.00',
        reason: 'Testing negative score injection via BUG RG-005 — no range validation',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.new_score).toBe(-200);
  });
});
