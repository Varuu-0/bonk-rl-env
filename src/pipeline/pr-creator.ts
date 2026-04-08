import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
}

export interface BranchConfig {
  issueId: number;
  issueNumber: number;
  issueTitle: string;
  repo: string;
  owner: string;
  baseBranch: string;
}

export class PRCreator {
  private repoPath: string;
  private token: string | null;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
    this.token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  }

  private runGit(args: string[], cwd: string = this.repoPath): string {
    try {
      return execSync(`git ${args.join(' ')}`, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      throw new Error(`Git command failed: ${error.message}`);
    }
  }

  private ensureCleanWorkingTree(): void {
    const status = this.runGit(['status', '--porcelain']);
    if (status.trim()) {
      throw new Error('Working tree is not clean. Commit or stash changes first.');
    }
  }

  private ensureUpToDate(): void {
    this.runGit(['fetch', 'origin']);
  }

  createBranch(config: BranchConfig): string {
    this.ensureCleanWorkingTree();
    this.ensureUpToDate();

    const { issueId, issueNumber, issueTitle, baseBranch } = config;
    const sanitizedTitle = issueTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const branchName = `fix/issue-${issueNumber}-${sanitizedTitle}-${issueId.substring(0, 8)}`;

    try {
      this.runGit(['checkout', '-b', branchName, `origin/${baseBranch}`]);
    } catch {
      this.runGit(['checkout', branchName]);
    }

    return branchName;
  }

  commitChanges(message: string, files?: string[]): void {
    if (files && files.length > 0) {
      for (const file of files) {
        this.runGit(['add', file]);
      }
    } else {
      this.runGit(['add', '-A']);
    }

    try {
      this.runGit(['commit', '-m', message]);
    } catch (error: any) {
      if (error.message.includes('nothing to commit')) {
        return;
      }
      throw error;
    }
  }

  pushBranch(branchName: string, force: boolean = false): void {
    const forceFlag = force ? '-f' : '';
    this.runGit(['push', '-u', 'origin', branchName, forceFlag].filter(Boolean));
  }

  async createPR(config: BranchConfig & { branchName: string; body?: string }): Promise<{ url: string; number: number }> {
    if (!this.token) {
      throw new Error('GitHub token not found. Set GITHUB_TOKEN or GH_TOKEN environment variable.');
    }

    const { owner, repo, branchName, issueNumber, issueTitle, baseBranch } = config;
    const title = `[Fix] ${issueTitle} (#${issueNumber})`;

    const body = this.formatPRBody(config);

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        body,
        head: branchName,
        base: baseBranch,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create PR: ${error}`);
    }

    const pr = await response.json();
    return { url: pr.html_url, number: pr.number };
  }

  private formatPRBody(config: BranchConfig & { body?: string }): string {
    const { issueNumber, issueTitle, body } = config;
    const lines = [
      `## Summary`,
      `- Fixes #${issueNumber}`,
      ``,
      `## Description`,
      `${issueTitle}`,
      '',
    ];

    if (body) {
      lines.push('');
      lines.push('## Reproduction');
      lines.push(body);
    }

    lines.push('');
    lines.push('## Checklist');
    lines.push('- [ ] Tests pass');
    lines.push('- [ ] Code follows style guidelines');
    lines.push('- [ ] Documentation updated (if needed)');

    return lines.join('\n');
  }

  async linkIssueToPR(issueNumber: number, prNumber: number): Promise<void> {
    if (!this.token) {
      throw new Error('GitHub token not found.');
    }

    const owner = process.env.GITHUB_OWNER || 'manifold-org';
    const repo = process.env.GITHUB_REPO || 'bonk-rl';

    const comment = `This issue is being addressed in #${prNumber}.`;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

    await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: comment }),
    });
  }

  async getPRStatus(prNumber: number): Promise<{ state: string; merged: boolean }> {
    if (!this.token) {
      throw new Error('GitHub token not found.');
    }

    const owner = process.env.GITHUB_OWNER || 'manifold-org';
    const repo = process.env.GITHUB_REPO || 'bonk-rl';

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const response = await fetch(apiUrl, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get PR status: ${response.statusText}`);
    }

    const pr = await response.json();
    return { state: pr.state, merged: pr.merged };
  }

  cleanupBranch(branchName: string, remote: boolean = true): void {
    this.runGit(['checkout', 'main']);

    try {
      this.runGit(['branch', '-d', branchName]);
    } catch {
      this.runGit(['branch', '-D', branchName]);
    }

    if (remote) {
      try {
        this.runGit(['push', 'origin', '--delete', branchName]);
      } catch {
        // Branch may not exist remotely
      }
    }
  }

  triggerLoopRestart(): void {
    const restartFile = join(this.repoPath, '.pipeline', 'restart-trigger');
    const dir = join(this.repoPath, '.pipeline');

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const timestamp = Date.now().toString();
    writeFileSync(restartFile, timestamp);
  }

  clearRestartTrigger(): void {
    const restartFile = join(this.repoPath, '.pipeline', 'restart-trigger');

    if (existsSync(restartFile)) {
      rmSync(restartFile);
    }
  }

  async handleMergedPR(config: BranchConfig & { branchName: string }): Promise<void> {
    const { branchName } = config;

    this.cleanupBranch(branchName, true);
    this.triggerLoopRestart();
  }
}

export function createPRCreator(repoPath?: string): PRCreator {
  return new PRCreator(repoPath);
}