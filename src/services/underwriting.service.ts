import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { AppError } from '../middleware/error-handler';
import { now } from '../utils/date';
import { LoanApplication } from '../types';

// ─── Interest rate ───────────────────────────────────────────────────────────

export function computeInterestRate(productType: string, scoreBand: string): number {
  const config = db
    .prepare(
      `SELECT base_rate_bps, risk_premium_bps
       FROM interest_rate_config
       WHERE product_type = ? AND score_band = ? AND is_active = 1`
    )
    .get(productType, scoreBand) as { base_rate_bps: number; risk_premium_bps: number } | undefined;

  if (!config) {
    throw new AppError(500, 'CONFIG_ERROR', `No interest rate config for ${productType}/${scoreBand}`);
  }

  // BUG RG-008: risk_premium_bps is stored as percent values (e.g., 2 meaning 2%)
  // so the sum understates the actual intended premium by 100x for non-zero premiums.
  return config.base_rate_bps + config.risk_premium_bps;
}

// ─── Auto-approval rules ─────────────────────────────────────────────────────

export function checkAutoApproval(
  application: Pick<
    LoanApplication,
    'requested_amount' | 'score_at_application' | 'debt_ratio_at_application' | 'available_limit_at_application'
  >,
  kycStatus: string
): { passes: boolean; failedRules: string[] } {
  const failedRules: string[] = [];

  if (application.requested_amount > 5000000) failedRules.push('amount_exceeds_auto_limit');
  if (application.score_at_application < 700) failedRules.push('score_below_threshold');
  if (kycStatus !== 'passed') failedRules.push('kyc_not_passed');

  // BUG RG-007: debt_ratio_at_application is null for first-time borrowers (no active debt).
  // The null-guard skips the check entirely — null is treated as "passes."
  // Correct behaviour: require debt_ratio_at_application to be explicitly computed and < 4000.
  if (application.debt_ratio_at_application != null && application.debt_ratio_at_application >= 4000) {
    failedRules.push('debt_ratio_too_high');
  }

  if (application.available_limit_at_application < application.requested_amount) {
    failedRules.push('insufficient_limit');
  }

  return { passes: failedRules.length === 0, failedRules };
}

// ─── Determine routing tier ──────────────────────────────────────────────────

export function determineTier(requestedAmount: number): 'auto' | 'manual' | 'committee' {
  if (requestedAmount > 50000000) return 'committee'; // > 500,000 SIM
  return 'manual';
}

// ─── Loan record creation ────────────────────────────────────────────────────

export function createLoanRecord(
  application: LoanApplication,
  tier: 'auto' | 'manual' | 'committee',
  decidedByUserId: string,
  notes?: string
): { loanId: string; rateBps: number } {
  const rateBps = computeInterestRate(application.product_type, application.band_at_application);
  const loanId = uuidv4();
  const ts = now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO loans
         (id, application_id, borrower_id, product_type, principal_amount,
          tenure_months, annual_interest_rate_bps, processing_fee_amount,
          status, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'approved', ?, ?, ?)`
    ).run(
      loanId,
      application.id,
      application.borrower_id,
      application.product_type,
      application.requested_amount,
      application.requested_tenure_months,
      rateBps,
      ts, ts, ts
    );

    db.prepare(
      `UPDATE loan_applications
       SET status = 'approved', approval_tier = ?, updated_at = ?
       WHERE id = ?`
    ).run(tier, ts, application.id);

    db.prepare(
      `INSERT INTO underwriting_decisions
         (id, application_id, decision, decided_by_user_id, decision_tier, notes, decided_at)
       VALUES (?, ?, 'approved', ?, ?, ?, ?)`
    ).run(uuidv4(), application.id, decidedByUserId, tier, notes ?? null, ts);
  })();

  return { loanId, rateBps };
}

// ─── Approve application ─────────────────────────────────────────────────────

export function approveApplication(
  applicationId: string,
  approverUserId: string,
  notes?: string
): { status: string; loanId?: string; rateBps?: number; message?: string } {
  const application = db
    .prepare('SELECT * FROM loan_applications WHERE id = ?')
    .get(applicationId) as LoanApplication | undefined;

  if (!application) throw new AppError(404, 'NOT_FOUND', 'Application not found');

  if (!['under_review', 'committee_review'].includes(application.status)) {
    throw new AppError(422, 'INVALID_STATE', `Cannot approve application in status: ${application.status}`);
  }

  const approver = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(approverUserId) as { id: string; role: string } | undefined;

  if (!approver || !['underwriter', 'senior_underwriter'].includes(approver.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Only underwriters can approve applications');
  }

  const borrower = db
    .prepare('SELECT * FROM borrowers WHERE id = ?')
    .get(application.borrower_id) as { id: string; employee_id: string } | undefined;

  if (!borrower) throw new AppError(404, 'NOT_FOUND', 'Borrower not found');

  // BUG RG-006: Only checks if the approver IS the borrower employee (self-approval).
  // Missing check: whether the approver is the borrower's direct manager.
  const approverEmployee = db
    .prepare('SELECT * FROM employees WHERE user_id = ?')
    .get(approverUserId) as { id: string } | undefined;

  const borrowerEmployee = db
    .prepare('SELECT * FROM employees WHERE id = ?')
    .get(borrower.employee_id) as { id: string; manager_user_id: string | null } | undefined;

  if (approverEmployee && borrowerEmployee && approverEmployee.id === borrowerEmployee.id) {
    throw new AppError(403, 'FORBIDDEN', 'Cannot approve own application');
  }
  // Correct check that is intentionally missing (BUG RG-006):
  // if (borrowerEmployee?.manager_user_id === approverUserId) {
  //   throw new AppError(403, 'FORBIDDEN', 'Cannot approve application from direct report');
  // }

  const ts = now();

  // Committee review: two-step approval
  if (application.status === 'committee_review') {
    if (!application.reviewed_by_user_id) {
      // First approval
      db.prepare(
        `UPDATE loan_applications
         SET reviewed_by_user_id = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(approverUserId, ts, ts, applicationId);

      db.prepare(
        `INSERT INTO underwriting_decisions
           (id, application_id, decision, decided_by_user_id, decision_tier, notes, decided_at)
         VALUES (?, ?, 'escalated_to_committee', ?, 'committee', ?, ?)`
      ).run(uuidv4(), applicationId, approverUserId, notes ?? null, ts);

      return { status: 'committee_review', message: 'First committee approval recorded; awaiting second approval from a senior_underwriter' };
    }

    // Second approval
    if (application.reviewed_by_user_id === approverUserId) {
      throw new AppError(409, 'CONFLICT', 'Same user cannot provide both committee approvals');
    }
    if (approver.role !== 'senior_underwriter') {
      throw new AppError(403, 'FORBIDDEN', 'Second committee approver must be a senior_underwriter');
    }

    db.prepare(
      `UPDATE loan_applications
       SET committee_reviewed_by_user_id = ?, committee_reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(approverUserId, ts, ts, applicationId);

    const { loanId, rateBps } = createLoanRecord(application, 'committee', approverUserId, notes);
    return { status: 'approved', loanId, rateBps };
  }

  // Manual (under_review) — single underwriter
  const { loanId, rateBps } = createLoanRecord(application, 'manual', approverUserId, notes);
  return { status: 'approved', loanId, rateBps };
}

// ─── Reject application ───────────────────────────────────────────────────────

export function rejectApplication(
  applicationId: string,
  rejectorUserId: string,
  reason: string
): void {
  const application = db
    .prepare('SELECT * FROM loan_applications WHERE id = ?')
    .get(applicationId) as LoanApplication | undefined;

  if (!application) throw new AppError(404, 'NOT_FOUND', 'Application not found');

  if (!['under_review', 'committee_review'].includes(application.status)) {
    throw new AppError(422, 'INVALID_STATE', `Cannot reject application in status: ${application.status}`);
  }

  const rejector = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(rejectorUserId) as { id: string; role: string } | undefined;

  if (!rejector || !['underwriter', 'senior_underwriter'].includes(rejector.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Only underwriters can reject applications');
  }

  const borrower = db
    .prepare('SELECT * FROM borrowers WHERE id = ?')
    .get(application.borrower_id) as { id: string; employee_id: string } | undefined;

  if (!borrower) throw new AppError(404, 'NOT_FOUND', 'Borrower not found');

  // BUG RG-006 applies here too — same missing manager check
  const rejectorEmployee = db
    .prepare('SELECT * FROM employees WHERE user_id = ?')
    .get(rejectorUserId) as { id: string } | undefined;

  const borrowerEmployee = db
    .prepare('SELECT * FROM employees WHERE id = ?')
    .get(borrower.employee_id) as { id: string; manager_user_id: string | null } | undefined;

  if (rejectorEmployee && borrowerEmployee && rejectorEmployee.id === borrowerEmployee.id) {
    throw new AppError(403, 'FORBIDDEN', 'Cannot reject own application');
  }

  const ts = now();

  db.transaction(() => {
    db.prepare(
      `UPDATE loan_applications
       SET status = 'rejected', rejection_reason = ?, reviewed_by_user_id = ?,
           reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(reason, rejectorUserId, ts, ts, applicationId);

    db.prepare(
      `INSERT INTO underwriting_decisions
         (id, application_id, decision, decided_by_user_id, decision_tier, notes, decided_at)
       VALUES (?, ?, 'rejected', ?, 'manual', ?, ?)`
    ).run(uuidv4(), applicationId, rejectorUserId, reason, ts);
  })();
}

// ─── Create appeal ────────────────────────────────────────────────────────────

export function createAppeal(
  applicationId: string,
  borrowerUserId: string,
  reason: string,
  additionalInfo?: string
): Appeal {
  const application = db
    .prepare('SELECT * FROM loan_applications WHERE id = ?')
    .get(applicationId) as LoanApplication | undefined;

  if (!application) throw new AppError(404, 'NOT_FOUND', 'Application not found');

  if (application.status !== 'rejected') {
    throw new AppError(422, 'INVALID_STATE', 'Can only appeal rejected applications');
  }

  const borrower = db
    .prepare(`SELECT b.* FROM borrowers b JOIN employees e ON e.id = b.employee_id WHERE e.user_id = ?`)
    .get(borrowerUserId) as { id: string } | undefined;

  if (!borrower || borrower.id !== application.borrower_id) {
    throw new AppError(403, 'FORBIDDEN', 'Only the borrower can appeal their application');
  }

  // BUG RG-009: No check for existing appeal — multiple appeals allowed per application.
  // Correct behaviour: check if an appeal already exists and throw ConflictError.
  // Missing:
  // const existing = db.prepare('SELECT 1 FROM appeals WHERE application_id = ?').get(applicationId);
  // if (existing) throw new AppError(409, 'CONFLICT', 'Appeal already submitted for this application');

  const appealId = uuidv4();
  const ts = now();

  db.prepare(
    `INSERT INTO appeals
       (id, application_id, borrower_id, reason, additional_info, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(appealId, applicationId, borrower.id, reason, additionalInfo ?? null, ts);

  return db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId) as Appeal;
}

// ─── Withdraw application ─────────────────────────────────────────────────────

export function withdrawApplication(applicationId: string, borrowerUserId: string): void {
  const application = db
    .prepare('SELECT * FROM loan_applications WHERE id = ?')
    .get(applicationId) as LoanApplication | undefined;

  if (!application) throw new AppError(404, 'NOT_FOUND', 'Application not found');

  const borrower = db
    .prepare(`SELECT b.* FROM borrowers b JOIN employees e ON e.id = b.employee_id WHERE e.user_id = ?`)
    .get(borrowerUserId) as { id: string } | undefined;

  if (!borrower || borrower.id !== application.borrower_id) {
    throw new AppError(403, 'FORBIDDEN', 'Only the borrower can withdraw their application');
  }

  // BUG RG-010: Missing status validation.
  // Should only allow: 'submitted', 'under_review', 'committee_review'.
  // Bug: allows withdrawing 'approved' applications, creating orphaned loans.
  db.prepare(
    `UPDATE loan_applications SET status = 'withdrawn', updated_at = ? WHERE id = ?`
  ).run(now(), applicationId);
}

// Re-export Appeal type locally for this module
interface Appeal {
  id: string;
  application_id: string;
  borrower_id: string;
  reason: string;
  additional_info: string | null;
  status: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
}
