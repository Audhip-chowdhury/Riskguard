import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { AppError } from '../middleware/error-handler';
import { now } from '../utils/date';
import { paisaToSim, simToPaisa } from '../utils/currency';
import { getPagination } from '../utils/pagination';
import { transferFromPayFlow } from './payflow.service';
import { logAuditEvent } from './complyhub-stub.service';
import { computeEmi, generateEmiSchedule } from './emi.service';
import { config } from '../config';
import {
  Loan, Borrower, Employee, EmiSchedule, User,
  DpdRecord, CollectionsAction, CollectionsAssignment,
  WriteOff, Recovery,
} from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLoan(loanId: string): Loan {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId) as Loan | undefined;
  if (!loan) throw new AppError(404, 'NOT_FOUND', 'Loan not found');
  return loan;
}

function computeTotalOutstanding(loanId: string): number {
  const firstPending = db
    .prepare(
      `SELECT opening_balance FROM emi_schedules
       WHERE loan_id = ? AND status IN ('scheduled', 'overdue', 'partial')
       ORDER BY installment_number ASC LIMIT 1`
    )
    .get(loanId) as { opening_balance: number } | undefined;
  return firstPending?.opening_balance ?? 0;
}

function extractTxnId(txnResult: unknown): string {
  const r = txnResult as Record<string, unknown>;
  const d = r?.data as Record<string, unknown> | undefined;
  return (d?.transaction_id as string) ?? (r?.transaction_id as string) ?? 'unknown';
}

// ─── Collections Queue (BUG RG-019) ───────────────────────────────────────────

export function getCollectionsQueue(
  queryParams: Record<string, unknown>,
  requestingUser: User
) {
  const { page, limit, offset } = getPagination(queryParams);
  const bucketFilter = queryParams.bucket as string | undefined;
  const agentIdFilter = queryParams.agent_id as string | undefined;

  // Agents see their own loans by default
  const effectiveAgentId =
    requestingUser.role === 'collections_agent' && !agentIdFilter
      ? requestingUser.id
      : agentIdFilter;

  // BUG RG-019: The queue query uses BETWEEN which is INCLUSIVE on both ends.
  // A loan at DPD=30 stored in bucket '1-30' also satisfies BETWEEN 30 AND 60
  // when querying the '31-60' bucket. So the same loan appears in two buckets.
  let dpdMin: number | null = null;
  let dpdMax: number | null = null;

  if (bucketFilter) {
    switch (bucketFilter) {
      case '1-30':   dpdMin = 1;  dpdMax = 30;   break;
      case '31-60':  dpdMin = 30; dpdMax = 60;   break;  // BUG RG-019: should be [31, 60]
      case '61-90':  dpdMin = 60; dpdMax = 90;   break;  // BUG RG-019: should be [61, 90]
      case '90+':    dpdMin = 90; dpdMax = 99999; break;
      case 'current': dpdMin = 0; dpdMax = 0;    break;
      default: throw new AppError(400, 'VALIDATION_ERROR', 'Invalid bucket value');
    }
  }

  const conditions: string[] = ['dpd.as_of_date = date(\'now\')'];
  const params: unknown[] = [];

  if (dpdMin !== null && dpdMax !== null) {
    if (bucketFilter === 'current') {
      conditions.push('dpd.days_past_due = 0');
    } else {
      conditions.push('dpd.days_past_due BETWEEN ? AND ?');
      params.push(dpdMin, dpdMax);
    }
  } else {
    // No bucket filter: return all loans with DPD > 0 (in collections)
    conditions.push('dpd.days_past_due > 0');
  }

  if (effectiveAgentId) {
    conditions.push('ca.agent_user_id = ?');
    params.push(effectiveAgentId);
  }

  const where = conditions.join(' AND ');

  const baseQuery = `
    FROM loans l
    JOIN dpd_records dpd ON dpd.loan_id = l.id
    LEFT JOIN collections_assignments ca ON ca.loan_id = l.id AND ca.is_active = 1
    WHERE ${where}
  `;

  const totalRow = db.prepare(`SELECT COUNT(*) as cnt ${baseQuery}`).get(...params) as { cnt: number };
  const total = totalRow.cnt;

  const rows = db.prepare(`
    SELECT l.id as loan_id, l.borrower_id, l.annual_interest_rate_bps,
           dpd.days_past_due, dpd.bucket, dpd.overdue_principal,
           dpd.overdue_interest, dpd.overdue_penalty,
           ca.agent_user_id
    ${baseQuery}
    ORDER BY dpd.days_past_due DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    loan_id: string;
    borrower_id: string;
    annual_interest_rate_bps: number;
    days_past_due: number;
    bucket: string;
    overdue_principal: number;
    overdue_interest: number;
    overdue_penalty: number;
    agent_user_id: string | null;
  }>;

  const data = rows.map(row => {
    const borrower = db.prepare(`
      SELECT b.id, u.username, e.department, b.current_score
      FROM borrowers b
      JOIN employees e ON e.id = b.employee_id
      JOIN users u ON u.id = e.user_id
      WHERE b.id = ?
    `).get(row.borrower_id) as { id: string; username: string; department: string; current_score: number } | undefined;

    const assignedAgent = row.agent_user_id
      ? (db.prepare('SELECT id, username FROM users WHERE id = ?').get(row.agent_user_id) as { id: string; username: string } | undefined) ?? null
      : null;

    const lastAction = db.prepare(`
      SELECT action_type, created_at FROM collections_actions
      WHERE loan_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(row.loan_id) as { action_type: string; created_at: string } | undefined;

    const outstanding = computeTotalOutstanding(row.loan_id);
    const overdueAmount = row.overdue_principal + row.overdue_interest + row.overdue_penalty;

    return {
      loan_id: row.loan_id,
      borrower: borrower ?? null,
      days_past_due: row.days_past_due,
      bucket: row.bucket,
      overdue_amount: paisaToSim(overdueAmount),
      outstanding_total: paisaToSim(outstanding),
      assigned_agent: assignedAgent,
      last_action: lastAction ?? null,
    };
  });

  return { data, meta: { page, limit, total } };
}

// ─── Restructure Loan (BUG RG-017) ────────────────────────────────────────────

export function restructureLoan(
  loanId: string,
  params: { new_tenure_months: number; new_annual_rate_bps: number; reason: string },
  approverId: string
) {
  const loan = getLoan(loanId);

  if (!['active', 'defaulted'].includes(loan.status)) {
    throw new AppError(422, 'INVALID_STATE', 'Loan must be active or defaulted to restructure');
  }

  const outstanding = computeTotalOutstanding(loanId);
  if (outstanding === 0) {
    throw new AppError(422, 'INVALID_STATE', 'No outstanding balance to restructure');
  }

  // Previous state
  const prevEmis = db.prepare(`
    SELECT * FROM emi_schedules
    WHERE loan_id = ? AND status IN ('scheduled', 'overdue', 'partial')
    ORDER BY installment_number ASC
  `).all(loanId) as EmiSchedule[];

  const previousRemainingMonths = prevEmis.length;
  const previousEmi = prevEmis[0]?.emi_amount ?? 0;

  if (previousRemainingMonths === params.new_tenure_months) {
    throw new AppError(422, 'VALIDATION_ERROR', 'New tenure must differ from remaining tenure');
  }

  const newEmi = computeEmi(outstanding, params.new_annual_rate_bps, params.new_tenure_months);

  const newSchedule = generateEmiSchedule(
    {
      ...loan,
      principal_amount: outstanding,
      annual_interest_rate_bps: params.new_annual_rate_bps,
      tenure_months: params.new_tenure_months,
    },
    new Date()
  );

  const restructuringId = uuidv4();
  const ts = now();

  // Find offset to avoid installment_number collision with existing rows
  const maxRow = db.prepare(
    `SELECT COALESCE(MAX(installment_number), 0) as mx FROM emi_schedules WHERE loan_id = ?`
  ).get(loanId) as { mx: number };
  const installmentOffset = maxRow.mx + 1000;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO restructurings
        (id, loan_id, previous_principal_outstanding, previous_tenure_remaining_months,
         previous_emi, previous_annual_rate_bps, new_tenure_months, new_emi,
         new_annual_rate_bps, reason, approved_by_user_id, new_schedule_generated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      restructuringId, loanId, outstanding, previousRemainingMonths,
      previousEmi, loan.annual_interest_rate_bps,
      params.new_tenure_months, newEmi, params.new_annual_rate_bps,
      params.reason, approverId, ts
    );

    // BUG RG-017: Old EMI schedule entries are NOT marked as 'superseded'.
    // The new schedule is inserted alongside the old pending entries.
    // The repayment-executor worker fetches ALL scheduled/overdue EMIs,
    // so both old and new EMIs get debited each cycle → double charge.
    //
    // Missing fix:
    // db.prepare(
    //   `UPDATE emi_schedules SET status='superseded'
    //    WHERE loan_id=? AND status IN ('scheduled','overdue','partial')`
    // ).run(loanId);

    for (const entry of newSchedule) {
      db.prepare(`
        INSERT INTO emi_schedules
          (id, loan_id, installment_number, due_date, emi_amount,
           principal_component, interest_component, opening_balance, closing_balance, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), loanId,
        entry.installment_number + installmentOffset,
        entry.due_date, entry.emi_amount,
        entry.principal_component, entry.interest_component,
        entry.opening_balance, entry.closing_balance,
        'scheduled'
      );
    }

    db.prepare(
      `UPDATE loans SET status='restructured', tenure_months=?, annual_interest_rate_bps=?, updated_at=? WHERE id=?`
    ).run(params.new_tenure_months, params.new_annual_rate_bps, ts, loanId);
  })();

  return {
    restructuring_id: restructuringId,
    loan_id: loanId,
    previous: {
      outstanding: paisaToSim(outstanding),
      remaining_emis: previousRemainingMonths,
      emi: paisaToSim(previousEmi),
      rate: (loan.annual_interest_rate_bps / 100).toFixed(2),
    },
    new: {
      outstanding: paisaToSim(outstanding),
      tenure_months: params.new_tenure_months,
      emi: paisaToSim(newEmi),
      rate: (params.new_annual_rate_bps / 100).toFixed(2),
    },
    new_schedule_generated: true,
  };
}

// ─── Write-Off (BUG RG-018) ───────────────────────────────────────────────────

export async function writeOffLoan(loanId: string, reason: string, adminUserId: string) {
  const loan = getLoan(loanId);

  // Must be defaulted or in 90+ DPD bucket
  const latestDpd = db.prepare(
    `SELECT * FROM dpd_records WHERE loan_id = ? ORDER BY as_of_date DESC LIMIT 1`
  ).get(loanId) as DpdRecord | undefined;

  const isEligible = loan.status === 'defaulted' || latestDpd?.bucket === '90+';
  if (!isEligible) {
    throw new AppError(
      422, 'INVALID_STATE',
      'Loan must be in defaulted status or 90+ DPD bucket to write off'
    );
  }

  const outstanding = computeTotalOutstanding(loanId);

  const unpaidEmis = db.prepare(`
    SELECT * FROM emi_schedules
    WHERE loan_id = ? AND status IN ('scheduled', 'overdue', 'partial')
  `).all(loanId) as EmiSchedule[];

  const interestLost = unpaidEmis.reduce((sum, e) => sum + e.interest_component, 0);
  const penaltyLost = unpaidEmis.reduce((sum, e) => sum + e.late_penalty, 0);

  const writeOffId = uuidv4();
  const ts = now();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO write_offs
        (id, loan_id, outstanding_at_write_off, principal_lost, interest_lost,
         penalty_lost, reason, written_off_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(writeOffId, loanId, outstanding, outstanding, interestLost, penaltyLost, reason, adminUserId, ts);

    db.prepare(`UPDATE loans SET status='written_off', updated_at=? WHERE id=?`).run(ts, loanId);

    // BUG RG-018: Borrower's credit exposure is NOT reset after write-off.
    // The written-off principal no longer shows up in debt_ratio (loan is no longer 'active'),
    // but there is no flag preventing the borrower from immediately applying for new credit.
    // A clean borrower credit profile means they can be auto-approved again at once.
    //
    // Missing fixes:
    //   1. Mark borrower with a write_off_history flag (excluded from auto-approval)
    //   2. Apply a severe credit score penalty
    //   3. Zero out borrower.available_limit until manually restored by admin
  })();

  await logAuditEvent({ type: 'loan_write_off', loan_id: loanId, amount: outstanding });

  const writeOff = db.prepare('SELECT * FROM write_offs WHERE id = ?').get(writeOffId) as WriteOff;

  return {
    write_off_id: writeOffId,
    loan_id: loanId,
    outstanding_at_write_off: paisaToSim(writeOff.outstanding_at_write_off),
    principal_lost: paisaToSim(writeOff.principal_lost),
    interest_lost: paisaToSim(writeOff.interest_lost),
    penalty_lost: paisaToSim(writeOff.penalty_lost),
    reason: writeOff.reason,
    created_at: writeOff.created_at,
  };
}

// ─── Record Recovery ──────────────────────────────────────────────────────────

export async function recordRecovery(
  loanId: string,
  params: { amount: string; recovery_source: string; notes?: string },
  userId: string
) {
  const loan = getLoan(loanId);

  if (loan.status !== 'written_off') {
    throw new AppError(422, 'INVALID_STATE', 'Loan must be in written_off status to record a recovery');
  }

  const writeOff = db.prepare(
    `SELECT * FROM write_offs WHERE loan_id = ?`
  ).get(loanId) as WriteOff | undefined;

  if (!writeOff) {
    throw new AppError(404, 'NOT_FOUND', 'Write-off record not found for this loan');
  }

  const amountPaise = simToPaisa(params.amount);

  const borrower = db.prepare('SELECT * FROM borrowers WHERE id = ?').get(loan.borrower_id) as Borrower;
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(borrower.employee_id) as Employee;

  const recoveryId = uuidv4();

  let txnResult: unknown;
  try {
    txnResult = await transferFromPayFlow({
      fromWalletId: employee.payflow_wallet_id,
      toWalletId: config.lendingWalletId,
      amount: paisaToSim(amountPaise),
      description: `Post-write-off recovery for loan ${loanId} (${params.recovery_source})`,
      idempotencyKey: `recovery-${recoveryId}`,
    });
  } catch (err) {
    throw new AppError(502, 'PAYFLOW_ERROR', `PayFlow transfer failed: ${(err as Error).message}`);
  }

  const txnId = extractTxnId(txnResult);
  const recoveredAt = now();

  db.prepare(`
    INSERT INTO recoveries
      (id, write_off_id, loan_id, recovered_amount, recovery_source,
       payflow_transaction_id, notes, recovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(recoveryId, writeOff.id, loanId, amountPaise, params.recovery_source, txnId, params.notes ?? null, recoveredAt);

  const recovery = db.prepare('SELECT * FROM recoveries WHERE id = ?').get(recoveryId) as Recovery;

  return {
    recovery_id: recovery.id,
    write_off_id: recovery.write_off_id,
    loan_id: recovery.loan_id,
    recovered_amount: paisaToSim(recovery.recovered_amount),
    recovery_source: recovery.recovery_source,
    payflow_transaction_id: recovery.payflow_transaction_id,
    notes: recovery.notes,
    recovered_at: recovery.recovered_at,
  };
}

// ─── Assign Agent (BUG RG-020) ────────────────────────────────────────────────

export function assignAgent(
  loanId: string,
  agentUserId: string,
  assignedByUserId: string,
  notes?: string
) {
  const loan = getLoan(loanId);

  // Must be in 60+ DPD bucket
  const latestDpd = db.prepare(
    `SELECT * FROM dpd_records WHERE loan_id = ? ORDER BY as_of_date DESC LIMIT 1`
  ).get(loanId) as DpdRecord | undefined;

  const eligibleBuckets = ['61-90', '90+'];
  if (!latestDpd || !eligibleBuckets.includes(latestDpd.bucket)) {
    throw new AppError(422, 'INVALID_STATE', 'Loan must be in 60+ DPD bucket to assign a collections agent');
  }

  const agent = db.prepare('SELECT * FROM users WHERE id = ?').get(agentUserId) as User | undefined;
  if (!agent) throw new AppError(404, 'NOT_FOUND', 'User not found');

  // BUG RG-020: No check that the agent's role is 'collections_agent'.
  // Any active user can be assigned, including employees, underwriters, etc.
  // Should be:
  // if (!['collections_agent', 'admin'].includes(agent.role)) {
  //   throw new AppError(422, 'VALIDATION_ERROR', 'Assigned user must have collections_agent role');
  // }

  const ts = now();
  const assignmentId = uuidv4();

  // Replace existing assignment (UNIQUE constraint on loan_id requires DELETE + INSERT)
  db.transaction(() => {
    db.prepare(`DELETE FROM collections_assignments WHERE loan_id = ?`).run(loanId);
    db.prepare(`
      INSERT INTO collections_assignments
        (id, loan_id, agent_user_id, assigned_at, assigned_by_user_id, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(assignmentId, loanId, agentUserId, ts, assignedByUserId);
  })();

  return {
    assignment_id: assignmentId,
    loan_id: loanId,
    agent_user_id: agentUserId,
    agent_username: agent.username,
    assigned_at: ts,
    notes: notes ?? null,
  };
}
