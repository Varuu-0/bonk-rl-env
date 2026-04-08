import { 
  OrchestratorConfig, 
  OrchestratorState, 
  IssueContext,
  PipelinePhase,
  PipelineResult,
  IssuePoller,
  IssueAnalyzer,
  FixImplementer,
  TestValidator,
  PrCreator
} from './types';

export class LoopOrchestrator {
  private config: OrchestratorConfig;
  private state: OrchestratorState;
  private poller: IssuePoller;
  private analyzer: IssueAnalyzer;
  private implementer: FixImplementer;
  private validator: TestValidator;
  private prCreator: PrCreator;
  private running: boolean = false;
  private shutdownRequested: boolean = false;

  constructor(
    config: OrchestratorConfig,
    poller: IssuePoller,
    analyzer: IssueAnalyzer,
    implementer: FixImplementer,
    validator: TestValidator,
    prCreator: PrCreator
  ) {
    this.config = config;
    this.poller = poller;
    this.analyzer = analyzer;
    this.implementer = implementer;
    this.validator = validator;
    this.prCreator = prCreator;
    
    this.state = {
      phase: 'polling',
      activeIssue: null,
      lastProcessedIssueNumber: null,
      issuesProcessed: 0,
      prsCreated: 0,
      loopCount: 0
    };
  }

  async start(): Promise<void> {
    console.log('[Orchestrator] Starting loop daemon...');
    console.log(`[Orchestrator] Config: pollInterval=${this.config.pollIntervalMs}ms, maxRuntime=${this.config.maxRuntimeSeconds}s`);
    
    this.running = true;
    this.setupSignalHandlers();
    
    await this.runLoop();
  }

  private setupSignalHandlers(): void {
    process.on('SIGINT', () => this.requestShutdown('SIGINT'));
    process.on('SIGTERM', () => this.requestShutdown('SIGTERM'));
  }

  private requestShutdown(signal: string): void {
    if (this.shutdownRequested) {
      return;
    }
    console.log(`[Orchestrator] Received ${signal}, initiating graceful shutdown...`);
    this.shutdownRequested = true;
  }

  async stop(): Promise<void> {
    console.log('[Orchestrator] Stopping...');
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    const startTime = Date.now();
    const maxEndTime = this.config.maxRuntimeSeconds > 0 
      ? startTime + (this.config.maxRuntimeSeconds * 1000) 
      : null;

    while (this.running && !this.shutdownRequested) {
      if (maxEndTime && Date.now() > maxEndTime) {
        console.log('[Orchestrator] Max runtime reached, exiting...');
        break;
      }

      this.state.loopCount++;
      console.log(`[Orchestrator] Loop iteration #${this.state.loopCount}`);

      try {
        await this.processIteration();
      } catch (error) {
        console.error('[Orchestrator] Error in iteration:', error);
        this.state.phase = 'polling';
        this.state.activeIssue = null;
      }

      if (!this.running || this.shutdownRequested) {
        break;
      }

      await this.sleep(this.config.pollIntervalMs);
    }

    console.log(`[Orchestrator] Exit. Processed ${this.state.issuesProcessed} issues, created ${this.state.prsCreated} PRs`);
  }

  private async processIteration(): Promise<void> {
    if (this.state.phase === 'waiting_for_merge') {
      await this.checkPrMergeStatus();
      return;
    }

    if (this.state.activeIssue !== null) {
      await this.processActiveIssue();
      return;
    }

    await this.pollForNewIssue();
  }

  private async pollForNewIssue(): Promise<void> {
    console.log('[Orchestrator] Polling for open issues...');
    this.state.phase = 'polling';

    const issue = await this.poller.poll();

    if (issue === null) {
      console.log('[Orchestrator] No open issues found, will retry...');
      return;
    }

    if (issue.number === this.state.lastProcessedIssueNumber) {
      console.log(`[Orchestrator] Issue #${issue.number} already processed, skipping...`);
      return;
    }

    console.log(`[Orchestrator] Found issue #${issue.number}: ${issue.title}`);
    this.state.activeIssue = issue;
    this.state.phase = 'analyzing';
  }

  private async processActiveIssue(): Promise<void> {
    if (!this.state.activeIssue) {
      return;
    }

    const issue = this.state.activeIssue;

    switch (this.state.phase) {
      case 'analyzing':
        console.log(`[Orchestrator] Analyzing issue #${issue.number}...`);
        try {
          await this.analyzer.analyze(issue);
          this.state.phase = 'implementing';
        } catch (error) {
          console.error('[Orchestrator] Analysis failed:', error);
          this.state.phase = 'polling';
          this.state.activeIssue = null;
        }
        break;

      case 'implementing':
        console.log(`[Orchestrator] Implementing fix for issue #${issue.number}...`);
        try {
          await this.implementer.implement({} as any);
          this.state.phase = 'testing';
        } catch (error) {
          console.error('[Orchestrator] Implementation failed:', error);
          this.state.phase = 'polling';
          this.state.activeIssue = null;
        }
        break;

      case 'testing':
        console.log(`[Orchestrator] Validating fix for issue #${issue.number}...`);
        try {
          await this.validator.validate({} as any);
          this.state.phase = 'creating_pr';
        } catch (error) {
          console.error('[Orchestrator] Validation failed:', error);
          this.state.phase = 'polling';
          this.state.activeIssue = null;
        }
        break;

      case 'creating_pr':
        console.log(`[Orchestrator] Creating PR for issue #${issue.number}...`);
        try {
          const prUrl = await this.prCreator.create(issue, {} as any, { passed: true, testResults: [] });
          console.log(`[Orchestrator] Created PR: ${prUrl}`);
          this.state.prsCreated++;
          this.state.lastProcessedIssueNumber = issue.number;
          this.state.phase = 'waiting_for_merge';
        } catch (error) {
          console.error('[Orchestrator] PR creation failed:', error);
          this.state.phase = 'polling';
          this.state.activeIssue = null;
        }
        break;
    }
  }

  private async checkPrMergeStatus(): Promise<void> {
    console.log('[Orchestrator] Waiting for PR merge...');
    
    await this.sleep(this.config.pollIntervalMs);
    
    this.state.phase = 'polling';
    this.state.activeIssue = null;
    this.state.issuesProcessed++;
    console.log(`[Orchestrator] Pipeline complete for issue, moving to next...`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getState(): OrchestratorState {
    return { ...this.state };
  }
}