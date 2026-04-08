import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OrchestratorDaemon,
  createOrchestrator,
  createOrchestratorConfig,
  GitHubIssue,
} from "../../src/orchestrator/orchestrator";

describe("OrchestratorDaemon", () => {
  let orchestrator: OrchestratorDaemon;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLog = vi.fn();
    mockFetch = vi.fn();

    const config = createOrchestratorConfig({
      owner: "test-owner",
      repo: "test-repo",
      token: "test-token",
      pollIntervalMs: 1000,
      log: mockLog,
    });

    orchestrator = createOrchestrator(config);

    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    orchestrator.stop();
    vi.unstubAllGlobals();
  });

  it("starts and stops correctly", () => {
    expect(orchestrator.isRunning()).toBe(false);

    orchestrator.start();
    expect(orchestrator.isRunning()).toBe(true);

    orchestrator.stop();
    expect(orchestrator.isRunning()).toBe(false);
  });

  it("maintains one active issue only", () => {
    orchestrator.start();

    const issue1: GitHubIssue = {
      id: 1,
      number: 1,
      title: "Issue 1",
      body: "Body 1",
      state: "open",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    const issue2: GitHubIssue = {
      id: 2,
      number: 2,
      title: "Issue 2",
      body: "Body 2",
      state: "open",
      created_at: "2024-01-02T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
    };

    orchestrator.setActiveIssue(issue1);
    expect(orchestrator.getActiveIssue()).toEqual(issue1);

    orchestrator.setActiveIssue(issue2);
    expect(orchestrator.getActiveIssue()).toEqual(issue2);
  });

  it("completes and clears active issue", () => {
    const issue: GitHubIssue = {
      id: 1,
      number: 1,
      title: "Test Issue",
      body: "Body",
      state: "open",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    orchestrator.setActiveIssue(issue);
    expect(orchestrator.getActiveIssue()).toEqual(issue);

    orchestrator.completeActiveIssue();
    expect(orchestrator.getActiveIssue()).toBeNull();
  });

  it("emits events correctly", () => {
    const startedHandler = vi.fn();
    const stoppedHandler = vi.fn();

    orchestrator.on("started", startedHandler);
    orchestrator.on("stopped", stoppedHandler);

    orchestrator.start();
    expect(startedHandler).toHaveBeenCalledTimes(1);

    orchestrator.stop();
    expect(stoppedHandler).toHaveBeenCalledTimes(1);
  });

  it("does not restart if already running", () => {
    orchestrator.start();
    expect(orchestrator.isRunning()).toBe(true);

    orchestrator.start();
    expect(orchestrator.isRunning()).toBe(true);
  });

  it("createOrchestratorConfig has default values", () => {
    const config = createOrchestratorConfig({
      owner: "test-owner",
      repo: "test-repo",
    });

    expect(config.github.pollIntervalMs).toBe(30000);
    expect(config.github.token).toBeUndefined();
    expect(typeof config.log).toBe("function");
  });

  it("createOrchestratorConfig accepts custom poll interval", () => {
    const config = createOrchestratorConfig({
      owner: "test-owner",
      repo: "test-repo",
      pollIntervalMs: 60000,
    });

    expect(config.github.pollIntervalMs).toBe(60000);
  });
});

describe("OrchestratorDaemon GitHub API", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches open issues", async () => {
    const mockIssues: GitHubIssue[] = [
      {
        id: 1,
        number: 1,
        title: "Test Issue",
        body: "Body",
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      },
    ];

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => mockIssues,
    });

    const config = createOrchestratorConfig({
      owner: "test-owner",
      repo: "test-repo",
      token: "test-token",
      pollIntervalMs: 1000,
      log: () => {},
    });

    const orchestrator = createOrchestrator(config);
    orchestrator.start();

    await new Promise((resolve) => setTimeout(resolve, 100));
    orchestrator.stop();
  });

  it("handles API errors gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Rate limit exceeded",
    });

    const config = createOrchestratorConfig({
      owner: "test-owner",
      repo: "test-repo",
      token: "test-token",
      pollIntervalMs: 1000,
      log: () => {},
    });

    const orchestrator = createOrchestrator(config);
    orchestrator.start();

    await new Promise((resolve) => setTimeout(resolve, 100));
    orchestrator.stop();
  });
});