import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { AppError } from '../middleware/error-handler';
import { now } from '../utils/date';
import { paisaToSim, simToPaisa } from '../utils/currency';
import { transferFromPayFlow } from './payflow.service';
import { screenAml } from './complyhub-stub.service';
import { generateEmiSchedule } from './emi.service';
import { config } from '../config';
import { Loan, Borrower, Employee, EmiSchedule, Disbursement } from '../types';

const PROCESSING_FEE_RATE = 0.01;
const MAX_PROCESSING_FEE_PAISE = 200000; // 2000 SIM

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

  if (!firstPending) return 0;
  return firstPending.opening_balance;
}

function getCurrentEmi(loanId: string): EmiSchedule | undefined {
  return db
    .prepare(
      `SELECT * FROM emi_schedules
       WHERE loan_id = ? AND status IN ('scheduled', 'overdue', 'partial')
       ORDER BY installment_number ASC LIMIT 1`
    )
    .get(loanId) as EmiSchedule | undefined;
}

function extractTxnId(txnResult: unknown): string {
  const r = txnResult as Record<string, unknown>;
  const d = r?.data as Record<string, unknown> | undefined;
  return (d?.transaction_id as string) ?? (r?.transaction_id as string) ?? 'unknown';
}

// ─── Disburse ─────────────────────────────────────────────────────────────────

export async function disburse(loanId: string, userId: string) {
  const loan = getLoan(loanId);

  if (loan.status !== 'approved') {
    throw new AppError(422, 'INVALID_STATE', 'Loan must be in approved status to disburse');
  }

  // Idempotency: return existing completed disbursement
  const existing = db
    .prepare(`SELECT * FROM disbursements WHERE loan_id = ? AND status = 'completed'`)
    .get(loanId) as Disbursement | undefined;
  if (existing) {
    const firstEmi = db
      .prepare(`SELECT due_date FROM emi_schedules WHERE loan_id = ? ORDER BY installment_number ASC LIMIT 1`)
      .get(loanId) as { due_date: string } | undefined;
    return {
      disbursement_id: existing.id,
      loan_id: loanId,
      requested_amount: paisaToSim(existing.requested_amount),
      processing_fee: paisaToSim(existing.processing_fee),
      net_disbursed_amount: paisaToSim(existing.net_disbursed_amount),
      payflow_transaction_id: existing.payflow_transaction_id,
      disbursed_at: existing.disbursed_at,
      schedule_generated: true,
      first_emi_due: firstEmi?.due_date ?? null,
    };
  }

  // AML screen
  await screenAml(uuidv4(), paisaToSim(loan.principal_amount));

  const processingFee = Math.min(
    Math.round(loan.principal_amount * PROCESSING_FEE_RATE),
    MAX_PROCESSING_FEE_PAISE
  );
  const netDisbursedAmount = loan.principal_amount - processingFee;

  const borrower = db
    .prepare('SELECT * FROM borrowers WHERE id = ?')
    .get(loan.borrower_id) as Borrower;
  const employee = db
    .prepare('SELECT * FROM employees WHERE id = ?')
    .get(borrower.employee_id) as Employee;

  const disbursementId = uuidv4();
  const ts = now();

  db.prepare(
    `INSERT INTO disbursements
       (id, loan_id, requested_amount, processing_fee, net_disbursed_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(disbursementId, loanId, loan.principal_amount, processingFee, netDisbursedAmount, ts);

  let txnResult: unknown;
  try {
    txnResult = await transferFromPayFlow({
      fromWalletId: config.lendingWalletId,
      toWalletId: employee.payflow_wallet_id,
      amount: paisaToSim(netDisbursedAmount),
      description: `Loan disbursement for ${loanId}`,
      idempotencyKey: `disbursement-${loanId}`,
    });
  } catch (err) {
    db.prepare(`UPDATE disbursements SET status='failed', error_message=? WHERE id=?`).run(
      (err as Error).message,
      disbursementId
    );
    throw new AppError(502, 'PAYFLOW_ERROR', `PayFlow transfer failed: ${(err as Error).message}`);
  }

  const disbursedAt = now();
  const txnId = extractTxnId(txnResult);

  db.prepare(
    `UPDATE disbursements SET status='completed', payflow_transaction_id=?, disbursed_at=? WHERE id=?`
  ).run(txnId, disbursedAt, disbursementId);

  db.prepare(`UPDATE loans SET status='disbursed', updated_at=? WHERE id=?`).run(disbursedAt, loanId);

  const scheduleEntries = generateEmiSchedule(loan, new Date(disbursedAt));

  for (const entry of scheduleEntries) {
    db.prepare(
      `INSERT INTO emi_schedules
         (id, loan_id, installment_number, due_date, emi_amount,
          principal_component, interest_component, opening_balance, closing_balance, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(),
      loanId,
      entry.installment_number,
      entry.due_date,
      entry.emi_amount,
      entry.principal_component,
      entry.interest_component,
      entry.opening_balance,
      entry.closing_balance,
      'scheduled'
    );
  }

  db.prepare(`UPDATE loans SET status='active', updated_at=? WHERE id=?`).run(now(), loanId);

  const firstEmi = scheduleEntries[0];

  return {
    disbursement_id: disbursementId,
    loan_id: loanId,
    requested_amount: paisaToSim(loan.principal_amount),
    processing_fee: paisaToSim(processingFee),
    net_disbursed_amount: paisaToSim(netDisbursedAmount),
    payflow_transaction_id: txnId,
    disbursed_at: disbursedAt,
    schedule_generated: true,
    first_emi_due: firstEmi?.due_date ?? null,
  };
}

// ─── Get Schedule ─────────────────────────────────────────────────────────────

export function getSchedule(loanId: string) {
  const loan = getLoan(loanId);

  const installments = db
    .prepare(`SELECT * FROM emi_schedules WHERE loan_id = ? ORDER BY installment_number ASC`)
    .all(loanId) as EmiSchedule[];

  const emiAmount = installments[0]?.emi_amount ?? 0;

  return {
    loan_id: loanId,
    total_emi: paisaToSim(emiAmount),
    tenure_months: loan.tenure_months,
    installments: installments.map(e => ({
      id: e.id,
      installment_number: e.installment_number,
      due_date: e.due_date,
      emi_amount: paisaToSim(e.emi_amount),
      principal_component: paisaToSim(e.principal_component),
      interest_component: paisaToSim(e.interest_component),
      opening_balance: paisaToSim(e.opening_balance),
      closing_balance: paisaToSim(e.closing_balance),
      status: e.status,
      paid_amount: paisaToSim(e.paid_amount),
      late_penalty: paisaToSim(e.late_penalty),
    })),
  };
}

// ─── Manual Repayment ─────────────────────────────────────────────────────────

export async function repayLoan(
  loanId: string,
  amountPaise: number,
  emiScheduleId: string | undefined,
  userId: string
) {
  const loan = getLoan(loanId);

  if (!['active', 'defaulted'].includes(loan.status)) {
    throw new AppError(422, 'INVALID_STATE', 'Loan must be active or defaulted to accept repayments');
  }

  // Find target EMI
  let targetEmi: EmiSchedule | undefined;
  if (emiScheduleId) {
    targetEmi = db
      .prepare(`SELECT * FROM emi_schedules WHERE id = ? AND loan_id = ?`)
      .get(emiScheduleId, loanId) as EmiSchedule | undefined;
    if (!targetEmi) throw new AppError(404, 'NOT_FOUND', 'EMI schedule entry not found');
  } else {
    targetEmi = db
      .prepare(
        `SELECT * FROM emi_schedules
         WHERE loan_id = ? AND status IN ('scheduled', 'overdue', 'partial')
         ORDER BY installment_number ASC LIMIT 1`
      )
      .get(loanId) as EmiSchedule | undefined;
    if (!targetEmi) throw new AppError(422, 'NO_PENDING_EMI', 'No pending EMI found for this loan');
  }

  const borrower = db
    .prepare('SELECT * FROM borrowers WHERE id = ?')
    .get(loan.borrower_id) as Borrower;
  const employee = db
    .prepare('SELECT * FROM employees WHERE id = ?')
    .get(borrower.employee_id) as Employee;

  // Breakdown: late_penalty → interest → principal
  const totalDue = targetEmi.emi_amount + targetEmi.late_penalty - targetEmi.paid_amount;
  let remaining = amountPaise;

  const latePenaltyPaid = Math.min(remaining, targetEmi.late_penalty);
  remaining -= latePenaltyPaid;

  const interestPaid = Math.min(remaining, targetEmi.interest_component);
  remaining -= interestPaid;

  const principalPaid = Math.min(remaining, targetEmi.principal_component);
  remaining -= principalPaid;

  const remainder = remaining; // leftover after fully paying this EMI

  const totalApplied = amountPaise - remainder;
  const newPaidAmount = targetEmi.paid_amount + totalApplied;
  const isFullyPaid = newPaidAmount >= targetEmi.emi_amount + targetEmi.late_penalty;

  const repaymentId = uuidv4();
  const ts = now();

  db.prepare(
    `INSERT INTO repayments
       (id, loan_id, emi_schedule_id, type, amount, principal_paid, interest_paid,
        late_penalty_paid, status, initiated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, 'pending', ?)`
  ).run(repaymentId, loanId, targetEmi.id, amountPaise, principalPaid, interestPaid, latePenaltyPaid, ts);

  let txnResult: unknown;
  try {
    txnResult = await transferFromPayFlow({
      fromWalletId: employee.payflow_wallet_id,
      toWalletId: config.lendingWalletId,
      amount: paisaToSim(amountPaise),
      description: `Manual repayment for loan ${loanId} EMI #${targetEmi.installment_number}`,
      idempotencyKey: `repay-${repaymentId}`,
    });
  } catch (err) {
    db.prepare(`UPDATE repayments SET status='failed', error_message=? WHERE id=?`).run(
      (err as Error).message,
      repaymentId
    );
    throw new AppError(502, 'PAYFLOW_ERROR', `PayFlow transfer failed: ${(err as Error).message}`);
  }

  const completedAt = now();
  const txnId = extractTxnId(txnResult);

  db.prepare(
    `UPDATE repayments SET status='completed', payflow_transaction_id=?, completed_at=? WHERE id=?`
  ).run(txnId, completedAt, repaymentId);

  db.prepare(
    `UPDATE emi_schedules SET status=?, paid_amount=?, paid_at=? WHERE id=?`
  ).run(isFullyPaid ? 'paid' : 'partial', newPaidAmount, completedAt, targetEmi.id);

  // Apply remainder to next installment if any
  const updatedEmis: { id: string; status: string; paid_amount: string }[] = [
    { id: targetEmi.id, status: isFullyPaid ? 'paid' : 'partial', paid_amount: paisaToSim(newPaidAmount) },
  ];

  if (remainder > 0) {
    const nextEmi = db
      .prepare(
        `SELECT * FROM emi_schedules
         WHERE loan_id = ? AND installment_number > ? AND status IN ('scheduled', 'overdue', 'partial')
         ORDER BY installment_number ASC LIMIT 1`
      )
      .get(loanId, targetEmi.installment_number) as EmiSchedule | undefined;

    if (nextEmi) {
      const nextPaid = nextEmi.paid_amount + remainder;
      const nextFull = nextPaid >= nextEmi.emi_amount + nextEmi.late_penalty;
      db.prepare(`UPDATE emi_schedules SET paid_amount=?, status=?, paid_at=? WHERE id=?`).run(
        nextPaid,
        nextFull ? 'paid' : 'partial',
        completedAt,
        nextEmi.id
      );
      updatedEmis.push({
        id: nextEmi.id,
        status: nextFull ? 'paid' : 'partial',
        paid_amount: paisaToSim(nextPaid),
      });
    }
  }

  const outstanding = computeTotalOutstanding(loanId);

  return {
    repayment_id: repaymentId,
    amount_applied: paisaToSim(amountPaise),
    breakdown: {
      principal: paisaToSim(principalPaid),
      interest: paisaToSim(interestPaid),
      late_penalty: paisaToSim(latePenaltyPaid),
      remainder: paisaToSim(remainder),
    },
    emi_schedule_updated: updatedEmis,
    loan_outstanding: paisaToSim(outstanding),
  };
}

// ─── Prepayment ───────────────────────────────────────────────────────────────

export async function prepayLoan(
  loanId: string,
  prepaymentAmountPaise: number | undefined,
  type: 'partial' | 'full',
  userId: string
) {
  const loan = getLoan(loanId);

  if (!['active', 'defaulted'].includes(loan.status)) {
    throw new AppError(422, 'INVALID_STATE', 'Loan must be active or defaulted to prepay');
  }

  const currentEmi = getCurrentEmi(loanId);
  if (!currentEmi) throw new AppError(422, 'NO_PENDING_EMI', 'No outstanding EMIs found');

  const totalOutstanding = computeTotalOutstanding(loanId);

  // BUG RG-013: Penalty calculated on totalOutstanding INCLUDING principal portion
  // of the current EMI that the borrower is already about to pay.
  // Correct: penalty should be on outstanding AFTER deducting current EMI's principal
  // (i.e., remaining principal AFTER current cycle)
  const penalty = Math.round(totalOutstanding * 0.02); // 2% of total — too high

  const borrower = db
    .prepare('SELECT * FROM borrowers WHERE id = ?')
    .get(loan.borrower_id) as Borrower;
  const employee = db
    .prepare('SELECT * FROM employees WHERE id = ?')
    .get(borrower.employee_id) as Employee;

  let actualPrepaymentAmount: number;
  if (type === 'full') {
    actualPrepaymentAmount = totalOutstanding;
    prepaymentAmountPaise = totalOutstanding + penalty;
  } else {
    if (!prepaymentAmountPaise) throw new AppError(400, 'VALIDATION_ERROR', 'amount is required for partial prepayment');
    actualPrepaymentAmount = prepaymentAmountPaise;
    prepaymentAmountPaise = prepaymentAmountPaise + penalty;
  }

  const totalPaid = prepaymentAmountPaise;

  const repaymentId = uuidv4();
  const ts = now();

  db.prepare(
    `INSERT INTO repayments
       (id, loan_id, type, amount, prepayment_penalty_paid, status, initiated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(repaymentId, loanId, type === 'full' ? 'full_prepayment' : 'partial_prepayment',
    totalPaid, penalty, ts);

  let txnResult: unknown;
  try {
    txnResult = await transferFromPayFlow({
      fromWalletId: employee.payflow_wallet_id,
      toWalletId: config.lendingWalletId,
      amount: paisaToSim(totalPaid),
      description: `${type === 'full' ? 'Full' : 'Partial'} prepayment for loan ${loanId}`,
      idempotencyKey: `prepay-${repaymentId}`,
    });
  } catch (err) {
    db.prepare(`UPDATE repayments SET status='failed', error_message=? WHERE id=?`).run(
      (err as Error).message, repaymentId
    );
    throw new AppError(502, 'PAYFLOW_ERROR', `PayFlow transfer failed: ${(err as Error).message}`);
  }

  const completedAt = now();
  const txnId = extractTxnId(txnResult);

  db.prepare(
    `UPDATE repayments SET status='completed', payflow_transaction_id=?, completed_at=? WHERE id=?`
  ).run(txnId, completedAt, repaymentId);

  const prepaymentId = uuidv4();
  db.prepare(
    `INSERT INTO prepayments
       (id, loan_id, type, prepayment_amount, penalty_amount, outstanding_at_prepayment,
        repayment_id, schedule_recalculated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(prepaymentId, loanId, type, actualPrepaymentAmount, penalty, totalOutstanding, repaymentId, 0, ts);

  let newOutstanding = 0;
  let remainingEmis = 0;
  let newEmi = '0.00';
  let scheduleRecalculated = false;

  if (type === 'full') {
    // Close loan — mark all remaining EMIs as superseded
    db.prepare(
      `UPDATE emi_schedules SET status='superseded' WHERE loan_id = ? AND status IN ('scheduled','overdue','partial')`
    ).run(loanId);
    db.prepare(`UPDATE loans SET status='prepaid', updated_at=? WHERE id=?`).run(completedAt, loanId);
    db.prepare(`UPDATE prepayments SET schedule_recalculated=1 WHERE id=?`).run(prepaymentId);
  } else {
    // Partial: reduce principal, regenerate remaining schedule
    const newPrincipal = totalOutstanding - actualPrepaymentAmount;
    if (newPrincipal <= 0) {
      // Effectively full payoff
      db.prepare(
        `UPDATE emi_schedules SET status='superseded' WHERE loan_id = ? AND status IN ('scheduled','overdue','partial')`
      ).run(loanId);
      db.prepare(`UPDATE loans SET status='prepaid', updated_at=? WHERE id=?`).run(completedAt, loanId);
    } else {
      // Supersede remaining schedule and regenerate
      db.prepare(
        `UPDATE emi_schedules SET status='superseded' WHERE loan_id = ? AND status IN ('scheduled','overdue','partial')`
      ).run(loanId);

      const remainingMonths = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM emi_schedules WHERE loan_id = ? AND status = 'superseded'
           AND installment_number > (
             SELECT COALESCE(MAX(installment_number),0) FROM emi_schedules WHERE loan_id = ? AND status = 'paid'
           )`
        )
        .get(loanId, loanId) as { cnt: number };

      const months = remainingMonths.cnt || loan.tenure_months || 12;

      // Build a synthetic loan object with the new principal for schedule generation
      const syntheticLoan = { ...loan, principal_amount: newPrincipal, tenure_months: months };
      const { generateEmiSchedule } = require('./emi.service');
      const newSchedule = generateEmiSchedule(syntheticLoan, new Date(completedAt));

      for (const entry of newSchedule) {
        db.prepare(
          `INSERT INTO emi_schedules
             (id, loan_id, installment_number, due_date, emi_amount,
              principal_component, interest_component, opening_balance, closing_balance, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuidv4(), loanId,
          entry.installment_number + 1000, // offset to avoid UNIQUE constraint on (loan_id, installment_number)
          entry.due_date, entry.emi_amount, entry.principal_component,
          entry.interest_component, entry.opening_balance, entry.closing_balance, 'scheduled'
        );
      }

      newOutstanding = newPrincipal;
      remainingEmis = newSchedule.length;
      newEmi = paisaToSim(newSchedule[0]?.emi_amount ?? 0);
      scheduleRecalculated = true;
      db.prepare(`UPDATE prepayments SET schedule_recalculated=1 WHERE id=?`).run(prepaymentId);
    }
  }

  return {
    prepayment_id: prepaymentId,
    type,
    prepayment_amount: paisaToSim(actualPrepaymentAmount),
    outstanding_at_prepayment: paisaToSim(totalOutstanding),
    penalty_amount: paisaToSim(penalty),
    total_paid: paisaToSim(totalPaid),
    new_outstanding: paisaToSim(newOutstanding),
    schedule_recalculated: scheduleRecalculated,
    remaining_emis: remainingEmis,
    new_emi: newEmi,
  };
}

// ─── Statement ────────────────────────────────────────────────────────────────

export function generateStatement(loanId: string) {
  const loan = getLoan(loanId);

  const disbursement = db
    .prepare(`SELECT * FROM disbursements WHERE loan_id = ?`)
    .get(loanId) as Disbursement | undefined;

  // BUG RG-015: The processing fee (deducted at disbursement) is NOT included in transactions list
  // Disbursement shows net_disbursed_amount only
  // Statement sums show: disbursed (net) + EMIs paid = ledger
  // But borrower's actual outflow: principal + interest + fees + penalties
  const transactions: Record<string, unknown>[] = [];

  if (disbursement) {
    transactions.push({
      type: 'disbursement',
      amount: paisaToSim(disbursement.net_disbursed_amount), // BUG: should also show processing_fee separately
      date: disbursement.disbursed_at,
    });
    // BUG RG-015: processing_fee is recorded in disbursements table but never appears here
  }

  const repayments = db
    .prepare(
      `SELECT * FROM repayments WHERE loan_id = ? AND status = 'completed' ORDER BY completed_at ASC`
    )
    .all(loanId) as import('../types').Repayment[];

  let totalPaid = 0;
  for (const r of repayments) {
    totalPaid += r.amount;
    if (r.type === 'auto_emi' || r.type === 'manual') {
      transactions.push({
        type: 'emi_payment',
        amount: paisaToSim(r.amount),
        principal: paisaToSim(r.principal_paid),
        interest: paisaToSim(r.interest_paid),
        late_penalty: paisaToSim(r.late_penalty_paid),
        date: r.completed_at,
      });
    } else if (r.type === 'partial_prepayment') {
      transactions.push({
        type: 'partial_prepayment',
        amount: paisaToSim(r.amount),
        penalty: paisaToSim(r.prepayment_penalty_paid),
        date: r.completed_at,
      });
    } else if (r.type === 'full_prepayment') {
      transactions.push({
        type: 'full_prepayment',
        amount: paisaToSim(r.amount),
        penalty: paisaToSim(r.prepayment_penalty_paid),
        date: r.completed_at,
      });
    }
  }

  const outstanding = computeTotalOutstanding(loanId);

  return {
    loan_id: loanId,
    principal_amount: paisaToSim(loan.principal_amount),
    current_outstanding: paisaToSim(outstanding),
    total_paid_to_date: paisaToSim(totalPaid),
    transactions,
  };
}
