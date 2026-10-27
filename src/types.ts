export type CriterionCategory = 'ทักษะ' | 'ประสบการณ์' | 'การศึกษา' | 'คุณสมบัติอื่น';
export type CandidateStatus = 'pending' | 'reviewed' | 'interview' | 'consider' | 'rejected';
export type ParseStatus = 'success' | 'error';

export interface Criterion {
  id: string;
  label: string;
  category: CriterionCategory;
  keywords: string[];
  weight: number;
}

export interface Job {
  id: string;
  title: string;
  department: string;
  description: string;
  minQualification: string;
  criteria: Criterion[];
  createdAt: string;
  updatedAt: string;
  criteriaVersion: number;
  isDemo?: boolean;
}

export interface CriterionResult {
  criterionId: string;
  label: string;
  category: CriterionCategory;
  weight: number;
  percent: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  evidence: string[];
  status: 'matched' | 'partial' | 'missing' | 'unknown';
}

export interface Candidate {
  id: string;
  jobId: string;
  name: string;
  email: string;
  phone: string;
  education: string;
  experience: string;
  skills: string[];
  fileName: string;
  rawText: string;
  parseStatus: ParseStatus;
  parseError?: string;
  score: number | null;
  results: CriterionResult[];
  status: CandidateStatus;
  analyzedAt: string | null;
  criteriaVersion: string;
  isDemo?: boolean;
  aiInsight?: string;
}

export type Page = 'dashboard' | 'candidates' | 'jobs' | 'upload' | 'reports';
