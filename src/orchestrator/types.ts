export interface OrchestratorConfig {
  pollIntervalMs: number;
  maxRuntimeSeconds: number;
  githubToken?: string;
  owner: string;
  repo: string;
}

export interface IssueContext {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
}

export type PipelinePhase = 
  | 'polling'
  | 'analyzing'
  | 'implementing'
  | 'testing'
  | 'creating_pr'
  | 'waiting_for_merge';

export interface OrchestratorState {
  phase: PipelinePhase;
  activeIssue: IssueContext | null;
  lastProcessedIssueNumber: number | null;
  issuesProcessed: number;
  prsCreated: number;
  loopCount: number;
}

export interface PipelineResult {
  success: boolean;
  error?: string;
  prUrl?: string;
}

export interface IssuePoller {
  poll(): Promise<IssueContext | null>;
}

export interface IssueAnalyzer {
  analyze(issue: IssueContext): Promise<AnalysisResult>;
}

export interface FixImplementer {
  implement(analysis: AnalysisResult): Promise<FixResult>;
}

export interface TestValidator {
  validate(fix: FixResult): Promise<ValidationResult>;
}

export interface PrCreator {
  create(issue: IssueContext, fix: FixResult, validation: ValidationResult): Promise<string>;
}

export interface AnalysisResult {
  affectedFiles: string[];
  rootCause: string;
  fixPlan: string;
  requiredTests: string[];
}

export interface FixResult {
  changes: FileChange[];
}

export interface FileChange {
  filePath: string;
  content: string;
  diff: string;
}

export interface ValidationResult {
  passed: boolean;
  testResults: TestResult[];
  error?: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}