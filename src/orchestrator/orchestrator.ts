import { EventEmitter } from "events";

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubConfig {
  owner: string;
  repo: string;
  token?: string;
  pollIntervalMs: number;
}

export interface OrchestratorConfig {
  github: GitHubConfig;
  log: (msg: string) => void;
}

export type OrchestratorEvent =
  | { type: "started" }
  | { type: "stopped" }
  | { type: "polling"; timestamp: number }
  | { type: "issue_found"; issue: GitHubIssue }
  | { type: "issue_completed"; issueId: number }
  | { type: "no_issues"; timestamp: number }
  | { type: "error"; error: Error };

export class OrchestratorDaemon extends EventEmitter {
  private config: OrchestratorConfig;
  private running = false;
  private activeIssue: GitHubIssue | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private ghCache: GitHubIssue[] = [];

  constructor(config: OrchestratorConfig) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.config.log("[orchestrator] Starting daemon...");
    this.emit("started");
    this.poll();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.config.log("[orchestrator] Daemon stopped.");
    this.emit("stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getActiveIssue(): GitHubIssue | null {
    return this.activeIssue;
  }

  setActiveIssue(issue: GitHubIssue | null): void {
    this.activeIssue = issue;
  }

  completeActiveIssue(): void {
    if (this.activeIssue) {
      this.config.log(`[orchestrator] Completed issue #${this.activeIssue.number}: ${this.activeIssue.title}`);
      this.emit("issue_completed", this.activeIssue.id);
      this.activeIssue = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    this.emit("polling", Date.now());
    this.config.log("[orchestrator] Polling GitHub for issues...");

    try {
      const issues = await this.fetchOpenIssues();

      if (issues.length === 0) {
        this.config.log("[orchestrator] No open issues found, waiting...");
        this.emit("no_issues", Date.now());
      } else {
        const oldest = this.selectOldestIssue(issues);
        this.config.log(`[orchestrator] Found issue #${oldest.number}: ${oldest.title}`);
        this.activeIssue = oldest;
        this.emit("issue_found", oldest);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.config.log(`[orchestrator] Polling error: ${err.message}`);
      this.emit("error", err);
    }

    if (this.running) {
      this.pollInterval = setTimeout(() => this.poll(), this.config.github.pollIntervalMs);
    }
  }

  private async fetchOpenIssues(): Promise<GitHubIssue[]> {
    const { owner, repo, token } = this.config.github;
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&sort=created&direction=asc`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "GitHub-Issue-Auto-Fixer-Pipeline",
    };

    if (token) {
      headers.Authorization = `token ${token}`;
    }

    try {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        const status = response.status;
        const text = await response.text().catch(() => "");
        throw new Error(`GitHub API error: ${status} ${text}`);
      }

      const data = await response.json() as GitHubIssue[];
      return data.filter((issue) => !(issue as Record<string, unknown>).pull_request);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("GitHub API")) {
        throw error;
      }
      throw new Error(`Failed to fetch issues: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private selectOldestIssue(issues: GitHubIssue[]): GitHubIssue {
    return issues.reduce((oldest, issue) => {
      if (!oldest) return issue;
      const oldestTime = new Date(oldest.created_at).getTime();
      const issueTime = new Date(issue.created_at).getTime();
      return issueTime < oldestTime ? issue : oldest;
    }, issues[0]);
  }

  async checkForMergedPRs(): Promise<boolean> {
    const { owner, repo, token } = this.config.github;
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "GitHub-Issue-Auto-Fixer-Pipeline",
    };

    if (token) {
      headers.Authorization = `token ${token}`;
    }

    try {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        return false;
      }

      const prs = await response.json() as Array<{ merged_at: string | null }>;
      return prs.some((pr) => pr.merged_at !== null);
    } catch {
      return false;
    }
  }
}

export function createOrchestrator(config: OrchestratorConfig): OrchestratorDaemon {
  return new OrchestratorDaemon(config);
}

export function createOrchestratorConfig(options: {
  owner: string;
  repo: string;
  token?: string;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}): OrchestratorConfig {
  return {
    github: {
      owner: options.owner,
      repo: options.repo,
      token: options.token,
      pollIntervalMs: options.pollIntervalMs ?? 30000,
    },
    log: options.log ?? ((msg) => console.log(msg)),
  };
}