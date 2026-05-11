import { z } from 'zod';
import db from '../db';
import { ScoringFactor } from '../types';

interface FactorResult {
  factor: string;
  raw_value: number;
  sub_score: number;
  weight: number;
}

export function computeTenureSubScore(joinedAt: Date): number {
  const yearsAtCompany = (Date.now() - joinedAt.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (yearsAtCompany < 0.5) return 100;
  if (yearsAtCompany < 1) return 300;
  if (yearsAtCompany < 2) return 500;
  if (yearsAtCompany < 5) return 750;
  return 950;
}

export function computeSalarySubScore(monthlySalary: number): number {
  const salaryInSim = monthlySalary / 100;
  if (salaryInSim < 30000) return 200;
  if (salaryInSim < 60000) return 450;
  if (salaryInSim < 100000) return 650;
  if (salaryInSim < 200000) return 800;
  return 950;
}

export function computeDebtRatioSubScore(activeDebt: number, monthlySalary: number): number {
  // BUG RG-002: No guard against monthlySalary being 0 or undefined
  // For new employees with no salary record, this returns NaN
  // NaN then propagates through computeFinalScore and stored as NaN in DB

  const ratio = activeDebt / monthlySalary; // NaN if monthlySalary is 0/undefined
  if (ratio < 0.1) return 950;
  if (ratio < 0.25) return 800;
  if (ratio < 0.4) return 600;
  if (ratio < 0.6) return 350;
  return 100;
}

export function computeRepaymentHistorySubScore(_borrowerId: string): number {
  // Phase 1: stub — no loan history yet
  return 600;
}

export function computeDepartmentRiskSubScore(tier: number): number {
  const map: Record<number, number> = { 1: 950, 2: 800, 3: 600, 4: 400, 5: 200 };
  return map[tier] ?? 600;
}

export function computeFinalScore(factors: FactorResult[]): number {
  // BUG RG-001: Normalization happens AFTER weight multiplication
  // Correct order would be: normalize weights to sum to 100% first, then multiply

  const weightedSum = factors.reduce((sum, f) => sum + f.sub_score * f.weight, 0);
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);

  // Bug: dividing by totalWeight here is fine ONLY if weights are already normalized to sum to 10000 (100%)
  // But scoring_factors.weight values may not sum to 10000 in practice
  // (e.g., if an admin toggles a factor off, weights are not auto-rebalanced)
  // This causes 5-15% score drift when active weights don't sum to 10000

  return Math.round(weightedSum / totalWeight);
}

export function assignBand(score: number): { band: string; creditLimit: number } {
  // BUG RG-003: Upper boundaries use >= 900 and <= 899 inconsistently
  // A score of exactly 600 is incorrectly placed in "Fair" instead of "Good"

  if (score >= 900) return { band: 'Excellent', creditLimit: 75000000 };
  if (score >= 750) return { band: 'Very Good', creditLimit: 30000000 };
  if (score > 600) return { band: 'Good', creditLimit: 10000000 }; // BUG: should be >= 600
  if (score >= 400) return { band: 'Fair', creditLimit: 2500000 };
  return { band: 'Poor', creditLimit: 0 };
}

export interface ScoreResult {
  score: number;
  band: string;
  creditLimit: number;
  factorBreakdown: Record<string, number>;
}

export function computeScore(params: {
  borrowerId: string;
  joinedAt: string;
  monthlySalary: number;
  departmentRiskTier: number;
}): ScoreResult {
  const factors = db
    .prepare('SELECT * FROM scoring_factors WHERE is_active = 1')
    .all() as ScoringFactor[];

  let activeDebt = 0;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(outstanding_amount), 0) AS total
         FROM loans
         WHERE borrower_id = ? AND status IN ('disbursed', 'overdue')`
      )
      .get(params.borrowerId) as { total: number } | undefined;
    activeDebt = row?.total ?? 0;
  } catch {
    // loans table does not exist yet (Phase 1)
    activeDebt = 0;
  }

  const joinedAt = new Date(params.joinedAt);
  const factorResults: FactorResult[] = [];
  const factorBreakdown: Record<string, number> = {};

  for (const factor of factors) {
    let subScore: number;
    switch (factor.factor_name) {
      case 'tenure':
        subScore = computeTenureSubScore(joinedAt);
        break;
      case 'salary':
        subScore = computeSalarySubScore(params.monthlySalary);
        break;
      case 'debt_ratio':
        subScore = computeDebtRatioSubScore(activeDebt, params.monthlySalary);
        break;
      case 'repayment_history':
        subScore = computeRepaymentHistorySubScore(params.borrowerId);
        break;
      case 'department_risk':
        subScore = computeDepartmentRiskSubScore(params.departmentRiskTier);
        break;
      default:
        subScore = 600;
    }
    factorResults.push({ factor: factor.factor_name, raw_value: 0, sub_score: subScore, weight: factor.weight });
    factorBreakdown[factor.factor_name] = subScore;
  }

  const score = computeFinalScore(factorResults);
  const { band, creditLimit } = assignBand(score);

  return { score, band, creditLimit, factorBreakdown };
}

export const manualAdjustSchema = z.object({
  new_score: z.number(), // BUG RG-005: no .min(0).max(1000) — accepts any number
  new_credit_limit: z.string().regex(/^\d+\.\d{2}$/),
  reason: z.string().min(20),
});
