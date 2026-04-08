import { Octokit } from 'octokit';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  repository: string;
  repositoryOwner: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  author: string;
}

export interface IssueMetadata {
  issue: GitHubIssue;
  reproductionSteps: string[];
  affectedFiles: string[];
  errorPatterns: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  issueType: 'bug' | 'feature' | 'enhancement' | 'documentation' | 'other';
}

export interface GitHubPollerConfig {
  owner: string;
  repo: string;
  token?: string;
  pollingIntervalMs: number;
  maxRetries: number;
  labels?: string[];
  state?: 'open' | 'all';
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
}

export interface IssueSelectionStrategy {
  select(issues: GitHubIssue[]): GitHubIssue;
}

export class PriorityBasedSelector implements IssueSelectionStrategy {
  private priorityLabels: Record<string, number> = {
    'bug': 100,
    'critical': 90,
    'high': 80,
    'medium': 60,
    'low': 40,
    'enhancement': 30,
    'feature': 20,
    'documentation': 10,
  };

  select(issues: GitHubIssue[]): GitHubIssue {
    let selected = issues[0];
    let maxScore = 0;

    for (const issue of issues) {
      let score = 0;
      
      for (const label of issue.labels) {
        const labelLower = label.toLowerCase();
        if (this.priorityLabels[labelLower]) {
          score += this.priorityLabels[labelLower];
        }
      }

      const createdDate = new Date(issue.createdAt).getTime();
      const daysOld = (Date.now() - createdDate) / (1000 * 60 * 60 * 24);
      score += Math.max(0, 50 - daysOld);

      if (score > maxScore) {
        maxScore = score;
        selected = issue;
      }
    }

    return selected;
  }
}

export class OldestUnassignedSelector implements IssueSelectionStrategy {
  select(issues: GitHubIssue[]): GitHubIssue {
    return issues.reduce((oldest, issue) => {
      const oldestDate = new Date(oldest.createdAt).getTime();
      const issueDate = new Date(issue.createdAt).getTime();
      return issueDate < oldestDate ? issue : oldest;
    });
  }
}

export class GitHubIssuePoller {
  private octokit: Octokit;
  private config: GitHubPollerConfig;
  private selector: IssueSelectionStrategy;
  private lastKnownIssues: Set<number> = new Set();
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: GitHubPollerConfig,
    selector: IssueSelectionStrategy = new PriorityBasedSelector()
  ) {
    this.config = config;
    this.selector = selector;
    this.octokit = new Octokit({
      auth: config.token,
    });
  }

  async poll(): Promise<GitHubIssue[]> {
    const { owner, repo, labels, state, sort, direction } = this.config;

    try {
      const response = await this.octokit.rest.issues.listForRepo({
        owner,
        repo,
        labels,
        state: state || 'open',
        sort: sort || 'updated',
        direction: direction || 'desc',
        per_page: 30,
      });

      const issues: GitHubIssue[] = response.data.map(issue => ({
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        state: issue.state as 'open' | 'closed',
        labels: issue.labels.map(l => typeof l === 'string' ? l : l.name),
        repository: repo,
        repositoryOwner: owner,
        htmlUrl: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        author: issue.user?.login || 'unknown',
      }));

      return issues;
    } catch (error) {
      console.error(`[GitHubPoller] Failed to poll issues:`, error);
      throw error;
    }
  }

  async getNewIssues(): Promise<GitHubIssue[]> {
    const issues = await this.poll();
    const newIssues = issues.filter(issue => !this.lastKnownIssues.has(issue.number));
    
    this.lastKnownIssues = new Set(issues.map(i => i.number));
    return newIssues;
  }

  selectIssue(issues: GitHubIssue[]): GitHubIssue | null {
    if (issues.length === 0) {
      return null;
    }
    return this.selector.select(issues);
  }

  startPolling(callback: (issues: GitHubIssue[]) => void): void {
    this.pollingInterval = setInterval(async () => {
      try {
        const issues = await this.poll();
        callback(issues);
      } catch (error) {
        console.error(`[GitHubPoller] Polling error:`, error);
      }
    }, this.config.pollingIntervalMs);
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async getIssueDetails(issueNumber: number): Promise<GitHubIssue | null> {
    const { owner, repo } = this.config;

    try {
      const response = await this.octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });

      const issue = response.data;
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        state: issue.state as 'open' | 'closed',
        labels: issue.labels.map(l => typeof l === 'string' ? l : l.name),
        repository: repo,
        repositoryOwner: owner,
        htmlUrl: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        author: issue.user?.login || 'unknown',
      };
    } catch (error) {
      console.error(`[GitHubPoller] Failed to get issue ${issueNumber}:`, error);
      return null;
    }
  }
}

const REPRODUCTION_PATTERNS = [
  /reproduction/i,
  /steps? to reproduce/i,
  /how to reproduce/i,
  /reproduce/i,
  /```/,
  /`/,
  /^```\w*/m,
];

const ERROR_PATTERNS = [
  /error/i,
  /exception/i,
  /failed/i,
  /crash/i,
  /panic/i,
  /undefined is not (a|an)/i,
  /cannot read/i,
  /is not defined/i,
  /TypeError/i,
  /ReferenceError/i,
  /SyntaxError/i,
];

const FILE_PATTERNS = [
  /src\/[^\s:]+\.ts/,
  /lib\/[^\s:]+\.js/,
  /\/[^\s/]+\.(ts|js|py|go|rs)\b/,
  /file: `[^\`]+`/,
  /at .+\.[jt]s:\d+/,
  /in `[^`]+`/,
];

export function extractMetadata(issue: GitHubIssue): IssueMetadata {
  const body = issue.body;
  
  const reproductionSteps = extractReproductionSteps(body);
  const affectedFiles = extractAffectedFiles(body);
  const errorPatterns = extractErrorPatterns(body);
  const severity = determineSeverity(issue.labels);
  const issueType = determineIssueType(issue.labels, body);

  return {
    issue,
    reproductionSteps,
    affectedFiles,
    errorPatterns,
    severity,
    issueType,
  };
}

function extractReproductionSteps(body: string): string[] {
  const steps: string[] = [];
  const lines = body.split('\n');
  let inCodeBlock = false;
  let inStepList = false;

  for (const line of lines) {
    if (REPRODUCTION_PATTERNS.some(p => p.test(line))) {
      inStepList = true;
    }

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      if (line.trim()) {
        steps.push(line.trim());
      }
      continue;
    }

    if (inStepList) {
      const trimmed = line.trim();
      if (trimmed.match(/^[-*]\s+/) || trimmed.match(/^\d+\.\s+/)) {
        steps.push(trimmed.replace(/^[-*]\s+|^\d+\.\s+/, ''));
      } else if (trimmed === '') {
        inStepList = false;
      }
    }
  }

  return steps.slice(0, 10);
}

function extractAffectedFiles(body: string): string[] {
  const files: Set<string> = new Set();
  
  for (const pattern of FILE_PATTERNS) {
    const matches = body.match(new RegExp(pattern, 'gi'));
    if (matches) {
      matches.forEach(m => {
        const file = m.replace(/`/g, '').trim();
        if (file && !file.startsWith('http')) {
          files.add(file);
        }
      });
    }
  }

  return Array.from(files).slice(0, 20);
}

function extractErrorPatterns(body: string): string[] {
  const errors: string[] = [];
  
  for (const pattern of ERROR_PATTERNS) {
    const matches = body.match(new RegExp(pattern, 'gi'));
    if (matches) {
      errors.push(...matches.slice(0, 5));
    }
  }

  const unique = [...new Set(errors)];
  return unique.slice(0, 10);
}

function determineSeverity(labels: string[]): 'low' | 'medium' | 'high' | 'critical' {
  const labelSet = new Set(labels.map(l => l.toLowerCase()));
  
  if (labelSet.has('critical') || labelSet.has('crash') || labelSet.has('blocker')) {
    return 'critical';
  }
  if (labelSet.has('high') || labelSet.has('bug') || labelSet.has('urgent')) {
    return 'high';
  }
  if (labelSet.has('medium') || labelSet.has('enhancement')) {
    return 'medium';
  }
  return 'low';
}

function determineIssueType(labels: string[], body: string): 'bug' | 'feature' | 'enhancement' | 'documentation' | 'other' {
  const labelSet = new Set(labels.map(l => l.toLowerCase()));
  
  if (labelSet.has('bug') || labelSet.has('bug report')) {
    return 'bug';
  }
  if (labelSet.has('feature') || labelSet.has('feature request')) {
    return 'feature';
  }
  if (labelSet.has('enhancement')) {
    return 'enhancement';
  }
  if (labelSet.has('docs') || labelSet.has('documentation')) {
    return 'documentation';
  }
  if (body.toLowerCase().includes('error') || body.toLowerCase().includes('exception')) {
    return 'bug';
  }
  if (body.toLowerCase().includes('should') || body.toLowerCase().includes('could')) {
    return 'feature';
  }
  return 'other';
}