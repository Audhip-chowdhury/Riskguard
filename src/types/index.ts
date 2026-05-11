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
