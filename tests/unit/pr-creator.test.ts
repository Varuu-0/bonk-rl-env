import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PRCreator, createPRCreator, BranchConfig } from '../../src/pipeline/pr-creator';

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('git status')) {
      return '';
    }
    if (cmd.includes('git fetch')) {
      return '';
    }
    if (cmd.includes('git checkout')) {
      return '';
    }
    if (cmd.includes('git branch')) {
      return '';
    }
    if (cmd.includes('git add')) {
      return '';
    }
    if (cmd.includes('git commit')) {
      return '';
    }
    if (cmd.includes('git push')) {
      return '';
    }
    return '';
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      return false;
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

describe('PRCreator', () => {
  let prCreator: PRCreator;

  beforeEach(() => {
    vi.clearAllMocks();
    prCreator = new PRCreator('/test/repo');
  });

  describe('constructor', () => {
    it('initializes with default repo path', () => {
      const creator = createPRCreator();
      expect(creator).toBeInstanceOf(PRCreator);
    });

    it('initializes with custom repo path', () => {
      const creator = createPRCreator('/custom/path');
      expect(creator).toBeInstanceOf(PRCreator);
    });
  });

  describe('createBranch', () => {
    it('creates branch with proper naming convention', () => {
      const config: BranchConfig = {
        issueId: 'abc123def456',
        issueNumber: 42,
        issueTitle: 'Fix bug in user authentication',
        repo: 'bonk-rl',
        owner: 'manifold-org',
        baseBranch: 'main',
      };

      const branchName = prCreator.createBranch(config);
      expect(branchName).toContain('fix/issue-42-');
    });

    it('sanitizes issue title for branch name', () => {
      const config: BranchConfig = {
        issueId: 'abc123',
        issueNumber: 1,
        issueTitle: 'Fix @#$% special chars!',
        repo: 'test-repo',
        owner: 'test-owner',
        baseBranch: 'main',
      };

      const branchName = prCreator.createBranch(config);
      expect(branchName).not.toContain('@');
      expect(branchName).not.toContain('#');
      expect(branchName).not.toContain('$');
    });

    it('truncates long titles', () => {
      const config: BranchConfig = {
        issueId: 'abc123',
        issueNumber: 1,
        issueTitle: 'A very long title that exceeds fifty characters and should be truncated',
        repo: 'test-repo',
        owner: 'test-owner',
        baseBranch: 'main',
      };

      const branchName = prCreator.createBranch(config);
      const titlePart = branchName.split('-').slice(2, -1).join('-');
      expect(titlePart.length).toBeLessThanOrEqual(50);
    });
  });

  describe('formatPRBody', () => {
    it('formats PR body with issue link', () => {
      const config: BranchConfig & { body?: string } = {
        issueId: 'abc123',
        issueNumber: 42,
        issueTitle: 'Test Issue',
        repo: 'test-repo',
        owner: 'test-owner',
        baseBranch: 'main',
        body: 'Reproduction steps here',
      };

      const prCreator = new PRCreator('/test/repo') as any;
      const body = prCreator.formatPRBody(config);

      expect(body).toContain('#42');
      expect(body).toContain('Reproduction');
      expect(body).toContain('Tests pass');
    });
  });

  describe('triggerLoopRestart', () => {
    it('creates restart trigger file', () => {
      prCreator.triggerLoopRestart();
      // Verify writeFileSync was called
      const fs = require('fs');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('clearRestartTrigger', () => {
    it('removes restart trigger file if exists', () => {
      const fs = require('fs') as any;
      fs.existsSync.mockReturnValueOnce(true);

      prCreator.clearRestartTrigger();
      expect(fs.rmSync).toHaveBeenCalled();
    });
  });

  describe('cleanupBranch', () => {
    it('removes local branch', () => {
      prCreator.cleanupBranch('fix/issue-1-test', false);
      const execSync = require('child_process').execSync;
      expect(execSync).toHaveBeenCalled();
    });
  });
});

describe('createPRCreator', () => {
  it('returns PRCreator instance', () => {
    const creator = createPRCreator();
    expect(creator).toBeInstanceOf(PRCreator);
  });
});