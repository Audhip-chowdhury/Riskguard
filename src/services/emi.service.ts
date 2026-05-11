import { Loan } from '../types';

export interface EmiScheduleEntry {
  installment_number: number;
  due_date: string;
  emi_amount: number;
  principal_component: number;
  interest_component: number;
  opening_balance: number;
  closing_balance: number;
  status: 'scheduled';
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Standard reducing-balance EMI formula:
 *   EMI = P * r * (1 + r)^n / ((1 + r)^n - 1)
 * Where:
 *   P = principal (paise, integer)
 *   r = monthly interest rate as decimal (annual_rate_bps / 12 / 10000)
 *   n = tenure in months
 */
export function computeEmi(principal: number, annualRateBps: number, tenureMonths: number): number {
  if (annualRateBps === 0) {
    return Math.round(principal / tenureMonths);
  }

  const r = annualRateBps / 12 / 10000; // monthly rate as decimal

  // BUG RG-011: Floating point accumulation
  // Using Math.pow with floats, results in trailing decimals
  // We round at the end, but the rounding error compounds across the schedule
  // because each EMI's interest is computed against a float balance
  const factor = Math.pow(1 + r, tenureMonths);
  const emi = (principal * r * factor) / (factor - 1);
  return Math.round(emi);
}

export function generateEmiSchedule(loan: Loan, disbursedAt: Date): EmiScheduleEntry[] {
  const emi = computeEmi(loan.principal_amount, loan.annual_interest_rate_bps, loan.tenure_months!);
  const schedule: EmiScheduleEntry[] = [];

  let balance = loan.principal_amount; // INTEGER paise

  for (let i = 1; i <= loan.tenure_months!; i++) {
    const dueDate = addMonths(disbursedAt, i);
    const monthlyRate = loan.annual_interest_rate_bps / 12 / 10000;

    // BUG RG-011 continued: interest is computed on float balance
    // Even though balance is stored as integer, the multiplication produces floats
    const interestComponent = Math.round(balance * monthlyRate);
    const principalComponent = emi - interestComponent;
    const newBalance = balance - principalComponent;

    schedule.push({
      installment_number: i,
      due_date: dueDate.toISOString().split('T')[0],
      emi_amount: emi,
      principal_component: principalComponent,
      interest_component: interestComponent,
      opening_balance: balance,
      closing_balance: newBalance,
      status: 'scheduled',
    });

    balance = newBalance;
  }

  // BUG RG-011: After all iterations, `balance` is rarely exactly 0
  // For a typical 24-month loan, balance ends up at +/- 50 paise
  // The schedule is generated as-is without correcting the final installment
  // This means the loan can never be fully "closed" — outstanding remains

  return schedule;
}
