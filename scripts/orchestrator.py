#!/usr/bin/env python3
"""
orchestrator.py — Infinite loop pipeline orchestrator

Runs forever, manages pipeline state, enforces one issue at a time rule,
and triggers restart after PRs are merged.

Usage:
    python scripts/orchestrator.py [--poll-interval SECONDS] [--api-url URL]
"""

import argparse
import os
import sys
import time
import json
import subprocess
from pathlib import Path
from typing import Optional

import requests


GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
REPO_OWNER = os.environ.get("REPO_OWNER", "convoy")
REPO_NAME = os.environ.get("REPO_NAME", "parallel-agent-issue-fixing-pipeline")
DEFAULT_POLL_INTERVAL = 30
DEFAULT_API_URL = "https://api.github.com"


class PipelineState:
    """Manages the current state of the pipeline."""

    IDLE = "idle"
    WORKING = "working"
    WAITING_FOR_PR = "waiting_for_pr"

    def __init__(self, state_file: str = "/tmp/orchestrator_state.json"):
        self.state_file = Path(state_file)
        self._current_state = self.IDLE
        self._current_issue: Optional[int] = None
        self._processed_issues: set[int] = set()
        self._load()

    def _load(self) -> None:
        """Load state from file."""
        if self.state_file.exists():
            try:
                data = json.loads(self.state_file.read_text())
                self._current_state = data.get("state", self.IDLE)
                self._current_issue = data.get("current_issue")
                self._processed_issues = set(data.get("processed_issues", []))
            except (json.JSONDecodeError, IOError):
                pass

    def _save(self) -> None:
        """Save state to file."""
        data = {
            "state": self._current_state,
            "current_issue": self._current_issue,
            "processed_issues": list(self._processed_issues),
        }
        self.state_file.write_text(json.dumps(data, indent=2))

    @property
    def state(self) -> str:
        return self._current_state

    @property
    def current_issue(self) -> Optional[int]:
        return self._current_issue

    def mark_working(self, issue_number: int) -> None:
        """Mark pipeline as working on an issue."""
        self._current_state = self.WORKING
        self._current_issue = issue_number
        self._save()

    def mark_idle(self) -> None:
        """Mark pipeline as idle."""
        if self._current_issue is not None:
            self._processed_issues.add(self._current_issue)
        self._current_state = self.IDLE
        self._current_issue = None
        self._save()

    def mark_waiting_for_pr(self) -> None:
        """Mark pipeline as waiting for PR to be merged."""
        self._current_state = self.WAITING_FOR_PR
        self._save()

    def reset_on_pr_merge(self) -> bool:
        """Check if we should reset due to PR merge. Returns True if reset occurred."""
        return False


class GitHubClient:
    """Client for interacting with GitHub API."""

    def __init__(self, token: Optional[str], api_url: str):
        self.token = token or GITHUB_TOKEN
        self.api_url = api_url
        self.session = requests.Session()
        if self.token:
            self.session.headers["Authorization"] = f"Bearer {self.token}"
        self.session.headers["Accept"] = "application/vnd.github.v3+json"

    def get_open_issues(self) -> list[dict]:
        """Fetch open issues from the repository."""
        url = f"{self.api_url}/repos/{REPO_OWNER}/{REPO_NAME}/issues"
        params = {"state": "open", "sort": "created", "direction": "asc"}
        try:
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Error fetching issues: {e}", file=sys.stderr)
            return []

    def get_issue_labels(self, issue_number: int) -> list[str]:
        """Get labels for a specific issue."""
        url = f"{self.api_url}/repos/{REPO_OWNER}/{REPO_NAME}/issues/{issue_number}"
        try:
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
            return [label["name"] for label in response.json().get("labels", [])]
        except requests.RequestException as e:
            print(f"Error fetching labels for issue #{issue_number}: {e}", file=sys.stderr)
            return []

    def get_recent_pr_merges(self, since: Optional[str] = None) -> list[dict]:
        """Get recently merged PRs."""
        url = f"{self.api_url}/repos/{REPO_OWNER}/{REPO_NAME}/pulls"
        params = {"state": "closed", "sort": "updated", "direction": "desc", "per_page": 10}
        try:
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            prs = response.json()
            merged = []
            for pr in prs:
                if pr.get("merged_at"):
                    if since is None or pr["merged_at"] > since:
                        merged.append(pr)
            return merged
        except requests.RequestException as e:
            print(f"Error fetching PRs: {e}", file=sys.stderr)
            return []

    def create_branch_for_issue(self, issue_number: int) -> str:
        """Create a branch for working on an issue."""
        branch_name = f"fix/issue-{issue_number}"
        print(f"Would create branch: {branch_name} for issue #{issue_number}")
        return branch_name


class Orchestrator:
    """Main orchestrator that runs forever, managing the issue fixing pipeline."""

    def __init__(
        self,
        poll_interval: int = DEFAULT_POLL_INTERVAL,
        api_url: str = DEFAULT_API_URL,
    ):
        self.poll_interval = poll_interval
        self.github = GitHubClient(GITHUB_TOKEN, api_url)
        self.state = PipelineState()
        self.last_pr_check = time.time()

    def log(self, message: str) -> None:
        """Log a message with timestamp."""
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        print(f"[{timestamp}] {message}")

    def check_for_new_work(self) -> Optional[dict]:
        """Check if there's new work available."""
        issues = self.github.get_open_issues()
        for issue in issues:
            issue_number = issue["number"]
            if issue_number not in self.state._processed_issues:
                labels = self.github.get_issue_labels(issue_number)
                return {"number": issue_number, "title": issue["title"], "labels": labels}
        return None

    def check_for_pr_merges(self) -> bool:
        """Check if any PRs have been merged and we need to restart."""
        prs = self.github.get_recent_pr_merges()
        if prs:
            self.log(f"Detected {len(prs)} merged PR(s)")
            return True
        return False

    def process_issue(self, issue: dict) -> None:
        """Process a single issue."""
        issue_number = issue["number"]
        self.log(f"Processing issue #{issue_number}: {issue['title']}")
        self.state.mark_working(issue_number)

    def trigger_restart(self) -> None:
        """Trigger a restart of the pipeline."""
        self.log("Triggering pipeline restart...")
        self.state.mark_idle()
        self.log("Pipeline restarted successfully")

    def run_once(self) -> bool:
        """Run one iteration of the orchestrator loop."""
        work = self.check_for_new_work()
        
        if work and self.state.state == PipelineState.IDLE:
            self.process_issue(work)
            return True
        elif self.state.state == PipelineState.WORKING:
            self.log(f"Currently working on issue #{self.state.current_issue}, waiting...")
            return True
        elif self.check_for_pr_merges():
            self.trigger_restart()
            return True
        else:
            return False

    def run(self) -> None:
        """Run the orchestrator in an infinite loop."""
        self.log(f"Starting orchestrator (poll interval: {self.poll_interval}s)")
        self.log(f"Repository: {REPO_OWNER}/{REPO_NAME}")

        iteration = 0
        while True:
            iteration += 1
            self.log(f"Iteration {iteration}: Checking for work...")
            
            try:
                self.run_once()
            except Exception as e:
                self.log(f"Error in iteration {iteration}: {e}")

            time.sleep(self.poll_interval)


def main():
    parser = argparse.ArgumentParser(description="Pipeline Orchestrator")
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL,
        help=f"Seconds between polling for new work (default: {DEFAULT_POLL_INTERVAL})",
    )
    parser.add_argument(
        "--api-url",
        type=str,
        default=DEFAULT_API_URL,
        help="GitHub API URL (default: https://api.github.com)",
    )
    args = parser.parse_args()

    orchestrator = Orchestrator(poll_interval=args.poll_interval, api_url=args.api_url)
    orchestrator.run()


if __name__ == "__main__":
    main()
