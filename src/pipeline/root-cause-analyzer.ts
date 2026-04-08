import * as path from 'path';
import * as fs from 'fs';

export interface RootCauseResult {
  rootCause: string;
  affectedFiles: string[];
  fixPlan: FixPlan;
  edgeCases: EdgeCase[];
  confidence: number;
}

export interface FixPlan {
  changes: FixChange[];
  risk: 'low' | 'medium' | 'high';
  estimatedComplexity: number;
}

export interface FixChange {
  file: string;
  line?: number;
  description: string;
  changeType: 'add' | 'remove' | 'modify';
  code?: string;
}

export interface EdgeCase {
  description: string;
  severity: 'low' | 'medium' | 'high';
  likelihood: number;
}

export interface ErrorContext {
  message: string;
  stack?: string;
  type: 'error' | 'warning' | 'exception';
  source?: string;
}

export class RootCauseAnalyzer {
  private projectRoot: string;
  private sourceFiles: Map<string, string> = new Map();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.loadSourceFiles();
  }

  private loadSourceFiles(): void {
    const srcDir = path.join(this.projectRoot, 'src');
    if (!fs.existsSync(srcDir)) return;

    const walkDir = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.sourceFiles.set(fullPath, content);
        }
      }
    };
    walkDir(srcDir);
  }

  analyze(error: ErrorContext): RootCauseResult {
    const patterns = this.detectPatterns(error);
    const affectedFiles = this.identifyAffectedFiles(error, patterns);
    const fixPlan = this.createFixPlan(error, patterns, affectedFiles);
    const edgeCases = this.identifyEdgeCases(error, patterns, affectedFiles);
    const confidence = this.calculateConfidence(error, patterns);

    return {
      rootCause: this.determineRootCause(error, patterns),
      affectedFiles,
      fixPlan,
      edgeCases,
      confidence,
    };
  }

  private detectPatterns(error: ErrorContext): DetectionPattern[] {
    const patterns: DetectionPattern[] = [];
    const message = error.message.toLowerCase();
    const stack = error.stack?.toLowerCase() || '';

    if (message.includes('undefined') || message.includes('null')) {
      patterns.push({ type: 'null_check', score: 0.9 });
    }
    if (message.includes('type error') || message.includes('is not a function')) {
      patterns.push({ type: 'type_mismatch', score: 0.85 });
    }
    if (message.includes('async') || message.includes('promise')) {
      patterns.push({ type: 'async_handling', score: 0.8 });
    }
    if (message.includes('memory') || message.includes('heap')) {
      patterns.push({ type: 'memory_issue', score: 0.9 });
    }
    if (message.includes('connection') || message.includes('refused')) {
      patterns.push({ type: 'connection_issue', score: 0.85 });
    }
    if (message.includes('worker') || message.includes('thread')) {
      patterns.push({ type: 'concurrency', score: 0.8 });
    }
    if (message.includes('sharedarraybuffer') || message.includes('shared memory')) {
      patterns.push({ type: 'shared_memory', score: 0.95 });
    }
    if (message.includes('ipc') || message.includes('message')) {
      patterns.push({ type: 'ipc_issue', score: 0.75 });
    }
    if (stack.includes('worker-pool') || stack.includes('worker-pool.ts')) {
      patterns.push({ type: 'worker_pool_issue', score: 0.9 });
    }
    if (message.includes('timeout') || message.includes('timed out')) {
      patterns.push({ type: 'timeout', score: 0.8 });
    }

    return patterns;
  }

  private identifyAffectedFiles(error: ErrorContext, patterns: DetectionPattern[]): string[] {
    const files = new Set<string>();
    const stack = error.stack || '';
    const message = error.message;

    const stackMatch = stack.match(/at\s+(?:.*?\s+)?\(?(.+?):(\d+):(\d+)\)?/g);
    if (stackMatch) {
      for (const match of stackMatch) {
        const fileMatch = match.match(/[\/\\]src[\/\\](.+?):(\d+)/);
        if (fileMatch) {
          files.add(`src/${fileMatch[1]}`);
        }
      }
    }

    for (const pattern of patterns) {
      switch (pattern.type) {
        case 'worker_pool_issue':
        case 'concurrency':
          files.add('src/core/worker-pool.ts');
          files.add('src/core/worker.ts');
          break;
        case 'shared_memory':
          files.add('src/ipc/shared-memory.ts');
          files.add('src/core/worker-pool.ts');
          break;
        case 'ipc_issue':
          files.add('src/ipc/ipc-bridge.ts');
          break;
        case 'memory_issue':
          files.add('src/core/physics-engine.ts');
          files.add('src/env/bonk-env.ts');
          break;
        case 'async_handling':
          files.add('src/server.ts');
          files.add('src/main.ts');
          break;
        case 'connection_issue':
          files.add('src/server.ts');
          break;
      }
    }

    if (files.size === 0) {
      files.add('src/main.ts');
    }

    return Array.from(files);
  }

  private createFixPlan(error: ErrorContext, patterns: DetectionPattern[], affectedFiles: string[]): FixPlan {
    const changes: FixChange[] = [];
    let risk: 'low' | 'medium' | 'high' = 'low';
    let complexity = 1;

    for (const pattern of patterns) {
      switch (pattern.type) {
        case 'null_check':
          changes.push({
            file: affectedFiles[0] || 'src/main.ts',
            description: 'Add null/undefined checks before accessing properties',
            changeType: 'modify',
          });
          break;
        case 'type_mismatch':
          changes.push({
            file: affectedFiles[0] || 'src/main.ts',
            description: 'Verify types match expected interface',
            changeType: 'modify',
          });
          complexity += 1;
          break;
        case 'async_handling':
          changes.push({
            file: affectedFiles[0] || 'src/main.ts',
            description: 'Ensure async operations properly await results',
            changeType: 'modify',
          });
          complexity += 1;
          risk = 'medium';
          break;
        case 'memory_issue':
          changes.push({
            file: affectedFiles[0] || 'src/main.ts',
            description: 'Review memory allocation and dispose of resources',
            changeType: 'modify',
          });
          risk = 'high';
          complexity += 2;
          break;
        case 'shared_memory':
          changes.push({
            file: 'src/ipc/shared-memory.ts',
            description: 'Verify SharedArrayBuffer initialization and cleanup',
            changeType: 'modify',
          });
          risk = 'high';
          complexity += 2;
          break;
        case 'timeout':
          changes.push({
            file: affectedFiles[0] || 'src/main.ts',
            description: 'Increase timeout or handle timeout gracefully',
            changeType: 'modify',
          });
          break;
      }
    }

    if (changes.length === 0) {
      changes.push({
        file: affectedFiles[0] || 'src/main.ts',
        description: 'Review and fix the reported issue',
        changeType: 'modify',
      });
    }

    return {
      changes,
      risk,
      estimatedComplexity: complexity,
    };
  }

  private identifyEdgeCases(error: ErrorContext, patterns: DetectionPattern[], affectedFiles: string[]): EdgeCase[] {
    const edgeCases: EdgeCase[] = [];
    const message = error.message.toLowerCase();

    if (patterns.some(p => p.type === 'async_handling')) {
      edgeCases.push({
        description: 'Race condition between async operations',
        severity: 'high',
        likelihood: 0.4,
      });
    }

    if (patterns.some(p => p.type === 'shared_memory')) {
      edgeCases.push({
        description: 'Cross-origin isolation not configured (requires COOP/COEP headers)',
        severity: 'high',
        likelihood: 0.6,
      });
      edgeCases.push({
        description: 'SharedArrayBuffer not supported in browser context',
        severity: 'medium',
        likelihood: 0.3,
      });
    }

    if (patterns.some(p => p.type === 'concurrency')) {
      edgeCases.push({
        description: 'Worker termination during active operation',
        severity: 'medium',
        likelihood: 0.2,
      });
    }

    if (patterns.some(p => p.type === 'memory_issue')) {
      edgeCases.push({
        description: 'Memory leak from unreleased references',
        severity: 'high',
        likelihood: 0.5,
      });
    }

    if (message.includes('batch') || message.includes('step')) {
      edgeCases.push({
        description: 'Partial batch failure leaving inconsistent state',
        severity: 'medium',
        likelihood: 0.3,
      });
    }

    if (affectedFiles.includes('src/core/worker-pool.ts')) {
      edgeCases.push({
        description: 'Worker failure causing cascade in parallel operations',
        severity: 'high',
        likelihood: 0.4,
      });
    }

    return edgeCases;
  }

  private determineRootCause(error: ErrorContext, patterns: DetectionPattern[]): string {
    if (patterns.length === 0) {
      return 'Unknown error - requires manual investigation';
    }

    const topPattern = patterns.reduce((a, b) => (a.score > b.score ? a : b));

    switch (topPattern.type) {
      case 'null_check':
        return 'Null or undefined value accessed without proper validation';
      case 'type_mismatch':
        return 'Type mismatch - value does not match expected type';
      case 'async_handling':
        return 'Async operation not properly handled - missing await or promise resolution';
      case 'memory_issue':
        return 'Memory allocation or deallocation issue causing runtime error';
      case 'shared_memory':
        return 'SharedArrayBuffer initialization or access issue in worker pool';
      case 'ipc_issue':
        return 'Inter-process communication failure between main thread and workers';
      case 'connection_issue':
        return 'Network or connection failure';
      case 'timeout':
        return 'Operation exceeded timeout threshold';
      case 'concurrency':
        return 'Concurrency issue in parallel worker operations';
      case 'worker_pool_issue':
        return 'Worker pool management issue affecting parallel environment execution';
      default:
        return `Detected error pattern: ${topPattern.type}`;
    }
  }

  private calculateConfidence(error: ErrorContext, patterns: DetectionPattern[]): number {
    if (patterns.length === 0) return 0.2;
    if (error.stack) return Math.min(0.95, 0.5 + patterns.reduce((a, b) => a + b.score, 0) / patterns.length);
    return Math.min(0.7, 0.3 + patterns.reduce((a, b) => a + b.score, 0) / patterns.length / 2);
  }

  suggestMinimalFix(error: ErrorContext): FixChange | null {
    const result = this.analyze(error);
    if (result.fixPlan.changes.length === 0) return null;

    const sorted = result.fixPlan.changes.sort((a, b) => {
      const aIsCore = a.file.includes('core') || a.file.includes('ipc') ? 1 : 0;
      const bIsCore = b.file.includes('core') || b.file.includes('ipc') ? 1 : 0;
      return aIsCore - bIsCore;
    });

    return sorted[0];
  }

  getAffectedFileContent(filePath: string): string | null {
    const fullPath = path.join(this.projectRoot, filePath);
    if (this.sourceFiles.has(fullPath)) {
      return this.sourceFiles.get(fullPath) || null;
    }
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    return null;
  }
}

interface DetectionPattern {
  type: string;
  score: number;
}

export function createAnalyzer(projectRoot: string): RootCauseAnalyzer {
  return new RootCauseAnalyzer(projectRoot);
}