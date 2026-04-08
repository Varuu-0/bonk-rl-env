import { Octokit } from '@octokit/rest';

export interface IssueMetadata {
  id: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'open' | 'closed';
  createdAt: string;
  labels: string[];
}

export interface PollingConfig {
  owner: string;
  repo: string;
  pollIntervalMs: number;
  maxBackoffMs: number;
  minBackoffMs: number;
}

const DEFAULT_POLLING_CONFIG: PollingConfig = {
  owner: 'Varuu-0',
  repo: 'bonk-rl-env',
  pollIntervalMs: 30000,
  maxBackoffMs: 300000,
  minBackoffMs: 5000,
};

export class IssuePoller {
  private octokit: Octokit;
  private config: PollingConfig;
  private backoffMs: number;
  private isPolling: boolean = false;

  constructor(token: string, config: Partial<PollingConfig> = {}) {
    this.octokit = new Octokit({ auth: token });
    this.config = { ...DEFAULT_POLLING_CONFIG, ...config };
    this.backoffMs = this.config.minBackoffMs;
  }

  async fetchOpenIssues(): Promise<IssueMetadata[]> {
    try {
      const response = await this.octokit.issues.listForRepo({
        owner: this.config.owner,
        repo: this.config.repo,
        state: 'open',
        per_page: 100,
      });

      return response.data.map(issue => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        url: issue.html_url,
        state: issue.state as 'open' | 'closed',
        createdAt: issue.created_at,
        labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name) || ''),
      }));
    } catch (error) {
      console.error('[Poller] Error fetching issues:', error);
      throw error;
    }
  }

  async selectOneIssue(processedIds: Set<number>): Promise<IssueMetadata | null> {
    const issues = await this.fetchOpenIssues();
    
    const unprocessed = issues.filter(issue => !processedIds.has(issue.id));
    
    if (unprocessed.length === 0) {
      return null;
    }

    const sorted = unprocessed.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return sorted[0];
  }

  async pollUntilIssueAvailable(
    processedIds: Set<number>,
    onIssueFound: (issue: IssueMetadata) => Promise<void>
  ): Promise<void> {
    this.isPolling = true;

    while (this.isPolling) {
      try {
        const issue = await this.selectOneIssue(processedIds);
        
        if (issue !== null) {
          this.resetBackoff();
          await onIssueFound(issue);
          return;
        }

        console.log(`[Poller] No unprocessed issues available, backing off for ${this.backoffMs}ms`);
        await this.sleep(this.backoffMs);
        this.increaseBackoff();
      } catch (error) {
        console.error('[Poller] Error in poll loop:', error);
        await this.sleep(this.backoffMs);
        this.increaseBackoff();
      }
    }
  }

  stopPolling(): void {
    this.isPolling = false;
  }

  private increaseBackoff(): void {
    this.backoffMs = Math.min(this.backoffMs * 2, this.config.maxBackoffMs);
  }

  private resetBackoff(): void {
    this.backoffMs = this.config.minBackoffMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getConfig(): PollingConfig {
    return { ...this.config };
  }
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[Poller] GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }

  const config: Partial<PollingConfig> = {};
  
  if (process.env.OWNER) config.owner = process.env.OWNER;
  if (process.env.REPO) config.repo = process.env.REPO;
  if (process.env.POLL_INTERVAL_MS) config.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS, 10);

  const poller = new IssuePoller(token, config);
  const processedIds = new Set<number>();

  console.log(`[Poller] Starting issue poller for ${poller.getConfig().owner}/${poller.getConfig().repo}`);

  await poller.pollUntilIssueAvailable(processedIds, async (issue) => {
    console.log(`[Poller] Found issue #${issue.number}: ${issue.title}`);
    console.log(`[Poller] URL: ${issue.url}`);
    console.log(`[Poller] Body: ${issue.body.substring(0, 200)}...`);
  });
}

if (require.main === module) {
  main().catch(console.error);
}
