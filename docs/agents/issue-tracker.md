# Issue tracker: GitHub

Issues live in `inDev42Labs/connections` on GitHub. Use the `gh` CLI.

Read this guide before accessing tickets. Authenticated access and remote writes require authorization under the applicable instructions. Documented commands are not authorization to execute them.

## Operations

Use `--repo inDev42Labs/connections` to select the repository explicitly.

```sh
gh issue create --repo inDev42Labs/connections --title "..." --body-file <path>
gh issue view <number> --repo inDev42Labs/connections --json number,title,body,labels,comments
gh issue list --repo inDev42Labs/connections --state open --json number,title,body,labels
gh issue comment <number> --repo inDev42Labs/connections --body-file <path>
gh issue edit <number> --repo inDev42Labs/connections --add-label "..."
gh issue edit <number> --repo inDev42Labs/connections --remove-label "..."
gh issue close <number> --repo inDev42Labs/connections --comment "..."
```

Use label and state filters as needed. List results are bounded; use pagination or suitable limits when complete enumeration matters. Read comments separately with `gh issue view`.

When a workflow says to publish to the issue tracker, create an issue here. When it says to fetch a ticket, read its body and comments.

## Parent tickets and blockers

Prefer native sub-issues and blocking relationships. Check installed CLI help before using version-dependent operations. Native API relationships use database issue IDs, not displayed issue numbers.

If native relationships are unavailable, put `Part of #<parent>` and `Blocked by: #<number>, #<number>` in each child body and list children as tasks in the parent. A ticket is unblocked when every blocker is closed.

## Work and evidence

Use issues for actionable remaining work, investigation notes, migration progress, and run-specific verification evidence. Keep accepted conventions, current contracts, and decision rationale in their project-owned documents.

Use [implementation triage](triage-labels.md) for implementation tickets. Do not apply those roles to research, alignment, or decision tickets.

## Maintenance

Owner approval is required to change the tracker convention. Changing trackers does not authorize moving or deleting existing issues.

Remote labels, access, and repository settings must be checked when an authorized workflow needs them; local setup does not establish them.
