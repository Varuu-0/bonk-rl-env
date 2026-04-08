import { LoopOrchestrator, OrchestratorConfig } from './orchestrator';

async function main(): Promise<void> {
  console.log('=== GitHub Issue Auto-Fixer Pipeline ===');

  const config: OrchestratorConfig = {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '30000', 10),
    maxRuntimeSeconds: parseInt(process.env.MAX_RUNTIME_SECONDS || '0', 10),
    githubToken: process.env.GITHUB_TOKEN,
    owner: process.env.REPO_OWNER || 'SneezingCactus',
    repo: process.env.REPO_NAME || 'manifold-server'
  };

  console.log(`Config: pollInterval=${config.pollIntervalMs}ms, maxRuntime=${config.maxRuntimeSeconds}s`);
  console.log(`Target: ${config.owner}/${config.repo}`);

  const orchestrator = new LoopOrchestrator(
    config,
    {
      poll: async () => {
        console.log('[MockPoller] Would poll GitHub API here');
        return null;
      }
    },
    {
      analyze: async (issue) => {
        console.log(`[MockAnalyzer] Would analyze issue #${issue.number}`);
        return { affectedFiles: [], rootCause: '', fixPlan: '', requiredTests: [] };
      }
    },
    {
      implement: async (analysis) => {
        console.log('[MockImplementer] Would apply fix here');
        return { changes: [] };
      }
    },
    {
      validate: async (fix) => {
        console.log('[MockValidator] Would run tests here');
        return { passed: true, testResults: [] };
      }
    },
    {
      create: async (issue, fix, validation) => {
        console.log(`[MockPrCreator] Would create PR for issue #${issue.number}`);
        return 'https://github.com/mock/pr/1';
      }
    }
  );

  await orchestrator.start();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});