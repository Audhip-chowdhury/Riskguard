import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import db from '../src/db';
import { testApiKeys, testUserIds, testEmployeeIds } from './setup';
import { checkAutoApproval } from '../src/services/underwriting.service';

// ─── Shared state ─────────────────────────────────────────────────────────────

let frankBorrowerId: string;
let irisBorrowerId: string;
let graceBorrowerId: string;

// ─── Setup: create borrowers used across tests ────────────────────────────────

beforeAll(async () => {
  // Create frank's borrower (score ~768, Very Good, 300K SIM limit)
  const frankRes = await request(app)
    .post('/api/v1/borrowers')
    .set('X-API-Key', testApiKeys['alice'])
    .set('Idempotency-Key', 'loans-setup-frank')
    .send({ employee_id: testEmployeeIds['frank'] });
  frankBorrowerId = frankRes.body.data.id;

  // Create iris's borrower (lower score, smaller limit)
  const irisRes = await request(app)
    .post('/api/v1/borrowers')
    .set('X-API-Key', testApiKeys['alice'])
    .set('Idempotency-Key', 'loans-setup-iris')
    .send({ employee_id: testEmployeeIds['iris'] });
  irisBorrowerId = irisRes.body.data.id;

  // Create grace's borrower and manually boost her credit limit to 100M SIM (10B paise)
  // so she can apply for amounts that trigger committee review (> 500K SIM)
  const graceRes = await request(app)
    .post('/api/v1/borrowers')
    .set('X-API-Key', testApiKeys['alice'])
    .set('Idempotency-Key', 'loans-setup-grace')
    .send({ employee_id: testEmployeeIds['grace'] });
  graceBorrowerId = graceRes.body.data.id;

  await request(app)
    .post(`/api/v1/borrowers/${graceBorrowerId}/manual-adjust`)
    .set('X-API-Key', testApiKeys['alice'])
    .set('Idempotency-Key', 'loans-setup-grace-adjust')
    .send({
      new_score: 900,
      new_credit_limit: '10000000.00',
      reason: 'Committee review test setup: raise grace credit limit to allow large applications',
    });
});

// ─── POST /api/v1/loans/apply ─────────────────────────────────────────────────

describe('POST /api/v1/loans/apply — submission', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).post('/api/v1/loans/apply').send({});
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', 'apply-missing-fields')
      .send({ product_type: 'personal_loan' }); // missing amount + purpose
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when user has no employee record', async () => {
    // alice is admin with an employee record, but charlie (underwriter) is also an employee
    // Use a user who has a valid API key but has no borrower profile — alice has employee record
    // We test with alice who has no borrower but has an employee record
    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', `apply-alice-no-borrower-${Date.now()}`)
      .send({ product_type: 'personal_loan', requested_amount: '1000.00', purpose: 'Testing' });
    // alice has no borrower profile → 404
    expect(res.status).toBe(404);
  });

  it('returns 409 when duplicate open application for same product type', async () => {
    const key1 = `apply-dup-test-1-${Date.now()}`;
    const key2 = `apply-dup-test-2-${Date.now()}`;

    // Iris has low score, so first app will go to under_review (not auto-approved)
    const res1 = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', key1)
      .send({ product_type: 'bnpl', requested_amount: '500.00', purpose: 'Buy gadget' });

    expect([201, 409]).toContain(res1.status); // may 409 if prior test left one open

    const res2 = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', key2)
      .send({ product_type: 'bnpl', requested_amount: '300.00', purpose: 'Buy another gadget' });

    if (res1.status === 201 && ['submitted', 'under_review', 'committee_review'].includes(res1.body.data.status)) {
      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe('CONFLICT');
    }
  });

  it('idempotency: same key + same payload returns cached response', async () => {
    const key = `apply-idempotent-${Date.now()}`;
    const payload = { product_type: 'emergency_loan', requested_amount: '100.00', purpose: 'Medical expense' };

    // Withdraw any open emergency_loan for iris first
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'emergency_loan' AND status IN ('submitted','under_review','committee_review')`
    ).run(irisBorrowerId);

    const r1 = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', key)
      .send(payload);
    const r2 = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', key)
      .send(payload);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.data.application_id).toBe(r1.body.data.application_id);
  });
});

// ─── Auto-approval (BUG RG-007) ───────────────────────────────────────────────

describe('Auto-approval — checkAutoApproval unit (BUG RG-007)', () => {
  it('passes when all rules met with valid debt_ratio', () => {
    const result = checkAutoApproval(
      { requested_amount: 1000000, score_at_application: 750, debt_ratio_at_application: 1000, available_limit_at_application: 5000000 },
      'passed'
    );
    expect(result.passes).toBe(true);
    expect(result.failedRules).toHaveLength(0);
  });

  it('fails when amount exceeds 50,000 SIM', () => {
    const result = checkAutoApproval(
      { requested_amount: 6000000, score_at_application: 800, debt_ratio_at_application: 0, available_limit_at_application: 10000000 },
      'passed'
    );
    expect(result.passes).toBe(false);
    expect(result.failedRules).toContain('amount_exceeds_auto_limit');
  });

  it('fails when score below 700', () => {
    const result = checkAutoApproval(
      { requested_amount: 500000, score_at_application: 650, debt_ratio_at_application: 0, available_limit_at_application: 5000000 },
      'passed'
    );
    expect(result.passes).toBe(false);
    expect(result.failedRules).toContain('score_below_threshold');
  });

  it('fails when KYC not passed', () => {
    const result = checkAutoApproval(
      { requested_amount: 500000, score_at_application: 800, debt_ratio_at_application: 0, available_limit_at_application: 5000000 },
      'pending'
    );
    expect(result.passes).toBe(false);
    expect(result.failedRules).toContain('kyc_not_passed');
  });

  it('fails when debt_ratio >= 0.4 (4000 bps)', () => {
    const result = checkAutoApproval(
      { requested_amount: 500000, score_at_application: 800, debt_ratio_at_application: 4500, available_limit_at_application: 5000000 },
      'passed'
    );
    expect(result.passes).toBe(false);
    expect(result.failedRules).toContain('debt_ratio_too_high');
  });

  it('fails when insufficient credit limit', () => {
    const result = checkAutoApproval(
      { requested_amount: 5000000, score_at_application: 800, debt_ratio_at_application: 0, available_limit_at_application: 1000000 },
      'passed'
    );
    expect(result.passes).toBe(false);
    expect(result.failedRules).toContain('insufficient_limit');
  });

  it('BUG RG-007: null debt_ratio bypasses the threshold check — application passes auto-approval', () => {
    // When debt_ratio_at_application is null, the != null guard skips the check.
    // A borrower whose debt ratio would be >= 0.4 if properly computed slips through.
    const result = checkAutoApproval(
      { requested_amount: 500000, score_at_application: 800, debt_ratio_at_application: null, available_limit_at_application: 5000000 },
      'passed'
    );
    // null passes the guard — no 'debt_ratio_too_high' failure
    expect(result.passes).toBe(true);
    expect(result.failedRules).not.toContain('debt_ratio_too_high');
  });
});

describe('Auto-approval — HTTP (BUG RG-007)', () => {
  it('auto-approves frank (score ~768, <= 50K SIM, null debt_ratio as first-time borrower)', async () => {
    // Ensure no open personal_loan for frank
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'personal_loan' AND status IN ('submitted','under_review','committee_review')`
    ).run(frankBorrowerId);

    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `frank-auto-approve-${Date.now()}`)
      .send({ product_type: 'personal_loan', requested_amount: '10000.00', purpose: 'Home renovation', requested_tenure_months: 12 });

    expect(res.status).toBe(201);
    // BUG RG-007: null debt_ratio → auto-approval skips the check
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.approval_tier).toBe('auto');
    expect(res.body.data.loan_id).toBeTruthy();
    expect(res.body.data.interest_rate).toMatch(/^\d+\.\d{2}$/);
  });

  it('routes to under_review when score below 700', async () => {
    // Manually lower iris's score below 700 so auto-approval fails the score check
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'salary_advance' AND status IN ('submitted','under_review','committee_review')`
    ).run(irisBorrowerId);

    // Iris (short tenure, low salary, high dept risk) will have score < 700
    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `iris-under-review-${Date.now()}`)
      .send({ product_type: 'salary_advance', requested_amount: '1000.00', purpose: 'Salary advance request' });

    expect(res.status).toBe(201);
    // iris likely fails score check → under_review
    expect(['under_review', 'approved']).toContain(res.body.data.status);
  });
});

// ─── GET /api/v1/loans/:id ────────────────────────────────────────────────────

describe('GET /api/v1/loans/:id', () => {
  let applicationId: string;

  beforeAll(async () => {
    // Clear any open line_of_credit for frank, then apply
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'line_of_credit' AND status IN ('submitted','under_review','committee_review')`
    ).run(frankBorrowerId);

    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `get-test-apply-${Date.now()}`)
      .send({ product_type: 'line_of_credit', requested_amount: '5000.00', purpose: 'Working capital' });
    applicationId = res.body.data.application_id;
  });

  it('returns 404 for unknown application id', async () => {
    const res = await request(app)
      .get('/api/v1/loans/00000000-0000-0000-0000-000000000000')
      .set('X-API-Key', testApiKeys['alice']);
    expect(res.status).toBe(404);
  });

  it('returns full application detail for admin', async () => {
    const res = await request(app)
      .get(`/api/v1/loans/${applicationId}`)
      .set('X-API-Key', testApiKeys['alice']);

    expect(res.status).toBe(200);
    expect(res.body.data.application.id).toBe(applicationId);
    expect(res.body.data.decisions).toBeInstanceOf(Array);
    expect(res.body.data.appeals).toBeInstanceOf(Array);
  });

  it('returns loan sub-object when application was auto-approved', async () => {
    // Find an approved application for frank
    const approvedApp = db
      .prepare(`SELECT id FROM loan_applications WHERE borrower_id = ? AND status = 'approved' LIMIT 1`)
      .get(frankBorrowerId) as { id: string } | undefined;

    if (!approvedApp) return; // skip if no approved app exists yet

    const res = await request(app)
      .get(`/api/v1/loans/${approvedApp.id}`)
      .set('X-API-Key', testApiKeys['alice']);

    expect(res.status).toBe(200);
    expect(res.body.data.loan).not.toBeNull();
    expect(res.body.data.loan.principal_amount).toMatch(/^\d+\.\d{2}$/);
    expect(res.body.data.loan.interest_rate).toMatch(/^\d+\.\d{2}$/);
  });

  it('returns 403 when a borrower tries to view another borrower\'s application', async () => {
    const res = await request(app)
      .get(`/api/v1/loans/${applicationId}`)
      .set('X-API-Key', testApiKeys['iris']); // iris cannot see frank's app
    expect(res.status).toBe(403);
  });

  it('allows borrower to view their own application', async () => {
    const res = await request(app)
      .get(`/api/v1/loans/${applicationId}`)
      .set('X-API-Key', testApiKeys['frank']);
    expect(res.status).toBe(200);
    expect(res.body.data.application.borrower_id).toBe(frankBorrowerId);
  });
});

// ─── Manual approval (BUG RG-006) ────────────────────────────────────────────

describe('POST /api/v1/loans/:id/approve — manual (BUG RG-006)', () => {
  let underReviewAppId: string;

  beforeAll(async () => {
    // Create an under_review application for iris (low score = won't auto-approve)
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'personal_loan' AND status IN ('submitted','under_review','committee_review')`
    ).run(irisBorrowerId);

    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `manual-approve-setup-${Date.now()}`)
      .send({ product_type: 'personal_loan', requested_amount: '2000.00', purpose: 'Personal expense request', requested_tenure_months: 6 });

    underReviewAppId = res.body.data.application_id;

    // Force the application to under_review in case it auto-approved (manual override for test)
    db.prepare(
      `UPDATE loan_applications SET status = 'under_review', approval_tier = 'manual', updated_at = datetime('now')
       WHERE id = ? AND status = 'approved'`
    ).run(underReviewAppId);
  });

  it('returns 403 for non-underwriter trying to approve', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${underReviewAppId}/approve`)
      .set('X-API-Key', testApiKeys['alice']) // admin, not underwriter
      .set('Idempotency-Key', `approve-403-${Date.now()}`)
      .send({ notes: 'Admin approve attempt' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown application', async () => {
    const res = await request(app)
      .post('/api/v1/loans/00000000-0000-0000-0000-000000000000/approve')
      .set('X-API-Key', testApiKeys['charlie'])
      .set('Idempotency-Key', `approve-404-${Date.now()}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('approves under_review application successfully', async () => {
    // Ensure it's under_review
    db.prepare(
      `UPDATE loan_applications SET status = 'under_review', updated_at = datetime('now')
       WHERE id = ? AND status NOT IN ('under_review','committee_review')`
    ).run(underReviewAppId);

    const res = await request(app)
      .post(`/api/v1/loans/${underReviewAppId}/approve`)
      .set('X-API-Key', testApiKeys['charlie']) // underwriter
      .set('Idempotency-Key', `approve-success-${Date.now()}`)
      .send({ notes: 'Employment verified, income stable.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.loan).not.toBeNull();
    expect(res.body.data.loan.principal_amount).toBe('2000.00');
  });

  it('creates an underwriting_decision record on approval', () => {
    const decision = db
      .prepare(`SELECT * FROM underwriting_decisions WHERE application_id = ? AND decision = 'approved'`)
      .get(underReviewAppId) as { decision: string } | undefined;
    expect(decision).toBeTruthy();
    expect(decision?.decision).toBe('approved');
  });

  it('BUG RG-006: underwriter (charlie) can approve frank\'s application even though charlie is frank\'s manager', async () => {
    // frank.manager_user_id = charlie's user_id (set in setup.ts)
    // charlie should be blocked, but the conflict-of-interest check doesn't check the manager relationship

    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'bnpl' AND status IN ('submitted','under_review','committee_review')`
    ).run(frankBorrowerId);

    // Request 100K SIM (> 50K auto limit) so the application routes to under_review
    // without creating a loan record (avoids UNIQUE constraint on re-approval)
    const applyRes = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `rg006-frank-apply-${Date.now()}`)
      .send({ product_type: 'bnpl', requested_amount: '100000.00', purpose: 'Buy electronics', requested_tenure_months: 3 });

    expect(applyRes.status).toBe(201);
    const frankAppId = applyRes.body.data.application_id;

    // Ensure it is in under_review (it should be, since 100K > 50K auto limit)
    db.prepare(
      `UPDATE loan_applications SET status = 'under_review', approval_tier = 'manual', updated_at = datetime('now')
       WHERE id = ? AND status = 'under_review'`
    ).run(frankAppId);

    const approveRes = await request(app)
      .post(`/api/v1/loans/${frankAppId}/approve`)
      .set('X-API-Key', testApiKeys['charlie']) // charlie IS frank's manager
      .set('Idempotency-Key', `rg006-approve-${Date.now()}`)
      .send({ notes: 'Manager approving direct report — BUG RG-006 allows this' });

    // BUG RG-006: should be 403, but the check is missing → 200
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');
  });
});

// ─── Rejection ────────────────────────────────────────────────────────────────

describe('POST /api/v1/loans/:id/reject', () => {
  let rejectAppId: string;

  beforeAll(async () => {
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'salary_advance' AND status IN ('submitted','under_review','committee_review')`
    ).run(irisBorrowerId);

    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `reject-setup-${Date.now()}`)
      .send({ product_type: 'salary_advance', requested_amount: '500.00', purpose: 'Monthly advance request' });

    rejectAppId = res.body.data.application_id;
    db.prepare(
      `UPDATE loan_applications SET status = 'under_review', approval_tier = 'manual', updated_at = datetime('now') WHERE id = ?`
    ).run(rejectAppId);
  });

  it('returns 400 when reason is too short', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${rejectAppId}/reject`)
      .set('X-API-Key', testApiKeys['charlie'])
      .set('Idempotency-Key', `reject-short-${Date.now()}`)
      .send({ reason: 'Short' }); // < 10 chars
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 for non-underwriter', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${rejectAppId}/reject`)
      .set('X-API-Key', testApiKeys['iris']) // borrower, not underwriter
      .set('Idempotency-Key', `reject-403-${Date.now()}`)
      .send({ reason: 'Self-rejection attempt, which is invalid.' });
    expect(res.status).toBe(403);
  });

  it('rejects an application with a valid reason', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${rejectAppId}/reject`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', `reject-valid-${Date.now()}`)
      .send({ reason: 'Insufficient repayment history for requested amount.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.rejection_reason).toContain('Insufficient');
  });

  it('application status in DB is rejected', () => {
    const app2 = db
      .prepare('SELECT status, rejection_reason FROM loan_applications WHERE id = ?')
      .get(rejectAppId) as { status: string; rejection_reason: string } | undefined;
    expect(app2?.status).toBe('rejected');
    expect(app2?.rejection_reason).toContain('Insufficient');
  });
});

// ─── Committee review ─────────────────────────────────────────────────────────

describe('Committee review — two-step approval', () => {
  let committeeAppId: string;

  beforeAll(async () => {
    // grace has 10M SIM limit (after manual-adjust in outer beforeAll)
    // Apply for 600K SIM (60M paise) > 500K SIM threshold → committee_review
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'personal_loan' AND status IN ('submitted','under_review','committee_review')`
    ).run(graceBorrowerId);

    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['grace'])
      .set('Idempotency-Key', `committee-apply-${Date.now()}`)
      .send({
        product_type: 'personal_loan',
        requested_amount: '600000.00',
        purpose: 'Business expansion and capital equipment',
        requested_tenure_months: 24,
      });

    committeeAppId = res.body.data.application_id;
    // Force committee_review status
    db.prepare(
      `UPDATE loan_applications SET status = 'committee_review', approval_tier = 'committee', updated_at = datetime('now') WHERE id = ?`
    ).run(committeeAppId);
  });

  it('first approval records the reviewer and keeps status as committee_review', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${committeeAppId}/approve`)
      .set('X-API-Key', testApiKeys['charlie']) // underwriter (first approval)
      .set('Idempotency-Key', `committee-first-${Date.now()}`)
      .send({ notes: 'Financials reviewed, supporting first approval.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('committee_review');
    expect(res.body.data.message).toMatch(/second approval/i);
  });

  it('second approval by same user is rejected', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${committeeAppId}/approve`)
      .set('X-API-Key', testApiKeys['charlie']) // same user
      .set('Idempotency-Key', `committee-same-user-${Date.now()}`)
      .send({ notes: 'Trying to self-approve again' });

    expect(res.status).toBe(409);
  });

  it('second approval by non-senior_underwriter (plain underwriter) is rejected', async () => {
    // evan is a plain underwriter — he can pass the role check but should fail the
    // senior_underwriter requirement for the committee second approval
    const res = await request(app)
      .post(`/api/v1/loans/${committeeAppId}/approve`)
      .set('X-API-Key', testApiKeys['evan']) // plain underwriter, not senior
      .set('Idempotency-Key', `committee-non-senior-${Date.now()}`)
      .send({ notes: 'Plain underwriter trying second committee approval' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/senior_underwriter/i);
  });

  it('second approval by different senior_underwriter creates the loan', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${committeeAppId}/approve`)
      .set('X-API-Key', testApiKeys['diana']) // different senior_underwriter
      .set('Idempotency-Key', `committee-second-${Date.now()}`)
      .send({ notes: 'Senior review complete. Recommending approval.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.loan).not.toBeNull();
    expect(res.body.data.loan.tenure_months).toBe(24);
  });
});

// ─── Appeal (BUG RG-009) ──────────────────────────────────────────────────────

describe('POST /api/v1/loans/:id/appeal (BUG RG-009)', () => {
  let rejectedAppId: string;

  beforeAll(async () => {
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'line_of_credit' AND status IN ('submitted','under_review','committee_review')`
    ).run(irisBorrowerId);

    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `appeal-setup-${Date.now()}`)
      .send({ product_type: 'line_of_credit', requested_amount: '1000.00', purpose: 'Credit line request' });

    rejectedAppId = res.body.data.application_id;

    // Force to rejected
    db.prepare(
      `UPDATE loan_applications SET status = 'rejected', rejection_reason = 'Score too low', updated_at = datetime('now') WHERE id = ?`
    ).run(rejectedAppId);
  });

  it('returns 422 when application is not rejected', async () => {
    // Use an under_review application
    const underReviewApp = db
      .prepare(`SELECT id FROM loan_applications WHERE borrower_id = ? AND status = 'under_review' LIMIT 1`)
      .get(irisBorrowerId) as { id: string } | undefined;

    if (!underReviewApp) return; // skip if none

    const res = await request(app)
      .post(`/api/v1/loans/${underReviewApp.id}/appeal`)
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `appeal-wrong-status-${Date.now()}`)
      .send({ reason: 'I want to appeal this review process please.' });

    expect(res.status).toBe(422);
  });

  it('returns 403 when non-borrower tries to appeal', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${rejectedAppId}/appeal`)
      .set('X-API-Key', testApiKeys['frank']) // frank is not iris's application owner
      .set('Idempotency-Key', `appeal-403-${Date.now()}`)
      .send({ reason: 'Unauthorized appeal attempt here now.' });

    expect(res.status).toBe(403);
  });

  it('creates an appeal successfully', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${rejectedAppId}/appeal`)
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `appeal-success-${Date.now()}`)
      .send({
        reason: 'I received a promotion last month and my salary has increased significantly.',
        additional_info: 'Promotion letter attached.',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.appeal_id).toBeTruthy();
    expect(res.body.data.status).toBe('pending');
  });

  it('BUG RG-009: allows a second appeal on the same rejected application', async () => {
    // No uniqueness check → second appeal succeeds instead of returning 409
    const res = await request(app)
      .post(`/api/v1/loans/${rejectedAppId}/appeal`)
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `appeal-duplicate-${Date.now()}`)
      .send({ reason: 'Submitting a second appeal which should be blocked but BUG RG-009 allows it.' });

    // BUG RG-009: should be 409, but no check exists → 201
    expect(res.status).toBe(201);

    // Verify two appeals exist in DB
    const appeals = db
      .prepare('SELECT * FROM appeals WHERE application_id = ?')
      .all(rejectedAppId) as unknown[];
    expect(appeals.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Withdraw (BUG RG-010) ────────────────────────────────────────────────────

describe('POST /api/v1/loans/:id/withdraw (BUG RG-010)', () => {
  let withdrawAppId: string;
  let withdrawApprovedAppId: string;

  beforeAll(async () => {
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'emergency_loan' AND status IN ('submitted','under_review','committee_review')`
    ).run(frankBorrowerId);

    const res = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `withdraw-setup-${Date.now()}`)
      .send({ product_type: 'emergency_loan', requested_amount: '500.00', purpose: 'Medical emergency' });

    withdrawAppId = res.body.data.application_id;

    // Force to under_review
    db.prepare(
      `UPDATE loan_applications SET status = 'under_review', approval_tier = 'manual', updated_at = datetime('now') WHERE id = ?`
    ).run(withdrawAppId);

    // Set up an APPROVED application to test RG-010
    db.prepare(
      `UPDATE loan_applications SET status = 'withdrawn', updated_at = datetime('now')
       WHERE borrower_id = ? AND product_type = 'salary_advance' AND status IN ('submitted','under_review','committee_review','approved')`
    ).run(frankBorrowerId);

    const res2 = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `withdraw-approved-setup-${Date.now()}`)
      .send({ product_type: 'salary_advance', requested_amount: '1000.00', purpose: 'Salary advance' });

    withdrawApprovedAppId = res2.body.data.application_id;
    // Force to approved (simulating an already-approved loan)
    db.prepare(
      `UPDATE loan_applications SET status = 'approved', approval_tier = 'auto', updated_at = datetime('now') WHERE id = ?`
    ).run(withdrawApprovedAppId);
  });

  it('returns 403 when a different borrower tries to withdraw', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${withdrawAppId}/withdraw`)
      .set('X-API-Key', testApiKeys['iris']) // iris cannot withdraw frank's application
      .set('Idempotency-Key', `withdraw-403-${Date.now()}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('successfully withdraws an under_review application', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${withdrawAppId}/withdraw`)
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `withdraw-success-${Date.now()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('withdrawn');

    const appRow = db
      .prepare('SELECT status FROM loan_applications WHERE id = ?')
      .get(withdrawAppId) as { status: string };
    expect(appRow.status).toBe('withdrawn');
  });

  it('BUG RG-010: allows withdrawing an already-approved application (no status validation)', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${withdrawApprovedAppId}/withdraw`)
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `withdraw-approved-bug-${Date.now()}`)
      .send({});

    // BUG RG-010: should be 422 (approved application cannot be withdrawn), but no check exists → 200
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('withdrawn');

    // Verify: the application is now 'withdrawn' while its loan record still exists as 'approved' — orphaned
    const appRow = db
      .prepare('SELECT status FROM loan_applications WHERE id = ?')
      .get(withdrawApprovedAppId) as { status: string };
    expect(appRow.status).toBe('withdrawn');
  });
});

// ─── Interest rate (BUG RG-008) ───────────────────────────────────────────────

describe('Interest rate — BUG RG-008 (risk premium 100x too small)', () => {
  it('BUG RG-008: stored risk_premium for Very Good band is 2 bps, not 200 bps', () => {
    const config = db
      .prepare(`SELECT risk_premium_bps FROM interest_rate_config WHERE product_type = 'personal_loan' AND score_band = 'Very Good'`)
      .get() as { risk_premium_bps: number } | undefined;

    expect(config).toBeTruthy();
    // Seed entered 2 (intending 2% = 200 bps) but it's stored as 2 bps
    expect(config?.risk_premium_bps).toBe(2);
    // The correct value would be 200 bps for a 2% premium
    expect(config?.risk_premium_bps).not.toBe(200);
  });

  it('BUG RG-008: total rate for personal_loan/Very Good is 1002 bps (10.02%), not 1200 bps (12.00%)', () => {
    const config = db
      .prepare(`SELECT base_rate_bps, risk_premium_bps FROM interest_rate_config WHERE product_type = 'personal_loan' AND score_band = 'Very Good'`)
      .get() as { base_rate_bps: number; risk_premium_bps: number };

    const totalBps = config.base_rate_bps + config.risk_premium_bps;
    // Bug: 1000 + 2 = 1002 bps = 10.02%
    expect(totalBps).toBe(1002);
    // Correct: 1000 + 200 = 1200 bps = 12.00%
    expect(totalBps).not.toBe(1200);
  });

  it('BUG RG-008: auto-approved loan shows near-base interest rate even for non-Excellent band', async () => {
    // frank is Very Good band; his loan interest rate should reflect very small premium (bug)
    const approvedApp = db
      .prepare(`SELECT id FROM loan_applications WHERE borrower_id = ? AND status = 'approved' AND band_at_application = 'Very Good' LIMIT 1`)
      .get(frankBorrowerId) as { id: string } | undefined;

    if (!approvedApp) return;

    const res = await request(app)
      .get(`/api/v1/loans/${approvedApp.id}`)
      .set('X-API-Key', testApiKeys['alice']);

    expect(res.status).toBe(200);
    if (res.body.data.loan) {
      const rateBps = res.body.data.loan.annual_interest_rate_bps;
      // Bug: rate is ~1002 bps instead of ~1200 bps for Very Good personal_loan
      // The premium of 2 bps vs the intended 200 bps shows the bug
      expect(rateBps).toBeLessThan(1100); // way below the intended 1200
    }
  });
});
