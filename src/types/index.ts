export interface User {
  id: string;
  username: string;
  email: string;
  api_key: string;
  role: 'employee' | 'underwriter' | 'senior_underwriter' | 'collections_agent' | 'admin';
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface Employee {
  id: string;
  user_id: string;
  payflow_wallet_id: string;
  department: string;
  designation: string;
  department_risk_tier: number;
  monthly_salary: number;
  joined_at: string;
  manager_user_id: string | null;
  created_at: string;
}

export interface Borrower {
  id: string;
  employee_id: string;
  current_score: number;
  current_band: string;
  credit_limit: number;
  available_limit: number;
  kyc_status: string;
  kyc_verified_at: string | null;
  last_scored_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScoreSnapshot {
  id: string;
  borrower_id: string;
  score: number;
  band: string;
  factor_breakdown: string;
  credit_limit_at_snapshot: number;
  reason: string;
  created_at: string;
}

export interface ScoringFactor {
  id: string;
  factor_name: string;
  weight: number;
  is_active: number;
  description: string | null;
  updated_at: string;
}

export interface LoanApplication {
  id: string;
  borrower_id: string;
  product_type: string;
  requested_amount: number;
  requested_tenure_months: number | null;
  purpose: string;
  status: string;
  approval_tier: string | null;
  score_at_application: number;
  band_at_application: string;
  available_limit_at_application: number;
  debt_ratio_at_application: number | null;
  submitted_at: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  committee_reviewed_by_user_id: string | null;
  committee_reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface Loan {
  id: string;
  application_id: string;
  borrower_id: string;
  product_type: string;
  principal_amount: number;
  tenure_months: number | null;
  annual_interest_rate_bps: number;
  processing_fee_amount: number;
  status: string;
  approved_at: string;
  created_at: string;
  updated_at: string;
}

export interface UnderwritingDecision {
  id: string;
  application_id: string;
  decision: string;
  decided_by_user_id: string;
  decision_tier: string;
  notes: string | null;
  rules_evaluated: string | null;
  decided_at: string;
}

export interface Appeal {
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
