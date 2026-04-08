import { spawn, ChildProcess } from 'child_process';
import { Octokit } from '@octokit/rest';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'open' | 'closed';
}

export interface PipelineState {
  currentIssue: Issue | null;
  currentPrUrl: string | null;
  processedIssueIds: Set<number>;
  iteration: number;
}

export interface OrchestratorConfig {
  owner: string;
  repo: string;
  pollIntervalMs: number;
  maxBackoffMs: number;
  minBackoffMs: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  owner: 'Varuu-0',
  repo: 'bonk-rl-env',
  pollIntervalMs: 30000,
  maxBackoffMs: 300000,
  minBackoffMs: 5000,
};

export class InfiniteLoopOrchestrator {
  private octokit: Octokit;
  private config: OrchestratorConfig;
  private state: PipelineState;
  private running: boolean = false;
  private backoffMs: number;

  constructor(token: string, config: Partial<OrchestratorConfig> = {}) {
    this.octokit = new Octokit({ auth: token });
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.backoffMs = this.config.minBackoffMs;
    this.state = this.createInitialState();
  }

  private createInitialState(): PipelineState {
    return {
      currentIssue: null,
      currentPrUrl: null,
      processedIssueIds: new Set(),
      iteration: 0,
    };
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[Orchestrator] Starting infinite loop orchestrator');
    console.log(`[Orchestrator] Watching ${this.config.owner}/${this.config.repo}`);

    while (this.running) {
      try {
        await this.processIteration();
      } catch (error) {
        console.error('[Orchestrator] Error in iteration:', error);
        await this.sleep(this.backoffMs);
        this.increaseBackoff();
      }
    }

    console.log('[Orchestrator] Orchestrator stopped');
  }

  stop(): void {
    this.running = false;
    console.log('[Orchestrator] Stopping orchestrator...');
  }

  private async processIteration(): Promise<void> {
    this.state.iteration++;
    console.log(`[Orchestrator] Iteration ${this.state.iteration}`);

    const openIssues = await this.fetchOpenIssues();
    
    if (openIssues.length === 0) {
      console.log('[Orchestrator] No open issues found');
      await this.handleNoIssues();
      return;
    }

    const unprocessedIssues = this.filterUnprocessedIssues(openIssues);
    
    if (unprocessedIssues.length === 0) {
      console.log('[Orchestrator] All issues have been processed');
      await this.handleAllIssuesProcessed();
      return;
    }

    this.resetBackoff();
    await this.processIssue(unprocessedIssues[0]);
  }

  private async fetchOpenIssues(): Promise<Issue[]> {
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
      }));
    } catch (error) {
      console.error('[Orchestrator] Error fetching issues:', error);
      throw error;
    }
  }

  private filterUnprocessedIssues(issues: Issue[]): Issue[] {
    return issues.filter(issue => !this.state.processedIssueIds.has(issue.id));
  }

  private async processIssue(issue: Issue): Promise<void> {
    console.log(`[Orchestrator] Processing issue #${issue.number}: ${issue.title}`);

    if (this.state.currentIssue !== null) {
      console.log('[Orchestrator] Warning: Already processing an issue, enforcing one-issue-at-a-time');
      return;
    }

    this.state.currentIssue = issue;

    try {
      const prUrl = await this.runIssueFixingPipeline(issue);
      this.state.currentPrUrl = prUrl;
      this.state.processedIssueIds.add(issue.id);
      
      console.log(`[Orchestrator] PR opened for issue #${issue.number}: ${prUrl}`);
      
      this.state.currentIssue = null;
      this.state.currentPrUrl = null;
    } catch (error) {
      console.error(`[Orchestrator] Error processing issue #${issue.number}:`, error);
      this.state.currentIssue = null;
      throw error;
    }
  }

  private async runIssueFixingPipeline(issue: Issue): Promise<string> {
    return new Promise((resolve, reject) => {
      const pipelineProcess = spawn('npm', ['run', 'pipeline:run', '--', '--issue', issue.number.toString()], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: { ...process.env, ISSUE_NUMBER: issue.number.toString() },
      });

      pipelineProcess.on('close', (code) => {
        if (code === 0) {
          resolve(`https://github.com/${this.config.owner}/${this.config.repo}/pull/${issue.number}`);
        } else {
          reject(new Error(`Pipeline exited with code ${code}`));
        }
      });

      pipelineProcess.on('error', (error) => {
        reject(error);
      });
    });
  }

  private async handleNoIssues(): Promise<void> {
    console.log(`[Orchestrator] No issues available, backing off for ${this.backoffMs}ms`);
    await this.sleep(this.backoffMs);
    this.increaseBackoff();
  }

  private async handleAllIssuesProcessed(): Promise<void> {
    console.log('[Orchestrator] All issues have been processed, exiting gracefully');
    console.log(`[Orchestrator] Total iterations: ${this.state.iteration}`);
    console.log(`[Orchestrator] Total issues processed: ${this.state.processedIssueIds.size}`);
    this.stop();
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

  getState(): PipelineState {
    return {
      ...this.state,
      processedIssueIds: new Set(this.state.processedIssueIds),
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[Orchestrator] GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }

  const config: Partial<OrchestratorConfig> = {};
  
  if (process.env.OWNER) config.owner = process.env.OWNER;
  if (process.env.REPO) config.repo = process.env.REPO;
  if (process.env.POLL_INTERVAL_MS) config.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS, 10);

  const orchestrator = new InfiniteLoopOrchestrator(token, config);

  process.on('SIGINT', () => {
    console.log('[Orchestrator] Received SIGINT, shutting down...');
    orchestrator.stop();
  });

  process.on('SIGTERM', () => {
    console.log('[Orchestrator] Received SIGTERM, shutting down...');
    orchestrator.stop();
  });

  await orchestrator.start();
}

if (require.main === module) {
  main().catch(console.error);
}
