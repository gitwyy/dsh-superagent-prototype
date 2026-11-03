For every ticket that changes UI, the PR/MR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose private Feishu content or credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI PR/MR is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

Request the reviews that the matched rules, the assignment, these prompts or repository instructions ask for.
Commit as the author this section names; when it names none, commit as the deployment's account and the commit identity the environment gives it — on GitHub its noreply address, on GitLab its commit email — never the operator's own identity.
Never enable auto-merge as the agent account, so the agent does not merge its own work: enable it only with the merge CLI this section names, as `<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha> --repo <the repository the environment names>` on GitHub or `<merge CLI> mr merge <number> --auto-merge --sha <sha> -R <the project the environment names>` on GitLab; never call one host's CLI on the other.
When this section names no merge CLI, a person merges every PR/MR.
With a merge CLI, enable auto-merge for the head commit of a PR/MR you opened from the ticket branch once all of these hold: it is ready; it changes fewer than 200 lines (additions plus deletions); each approval those instructions require covers that commit; and if it changes what users see, those instructions name who approves such changes and that approval covers the commit.
Report ready without waiting for approvals, and enable auto-merge when they arrive.
Otherwise a person merges it; say so in your report.
A protected branch accepts a push or a merge only from the roles its rules name: where the environment reports that this account may not push the default branch or may not merge, open the PR/MR and report it for a person to merge, never force-pushing.
Withdraw auto-merge with `<merge CLI> pr merge <number> --disable-auto --repo <the repository the environment names>` on GitHub, or on GitLab by turning merge-when-pipeline-succeeds off with the merge CLI's glab api, as soon as any of these stops holding, such as when a review requests changes, and before you push to the PR/MR; enable it again once they hold for the new head.
Never approve or merge on behalf of a reviewer.
Credit each person who reviews a PR/MR you opened, once per PR/MR, on every commit of the PR/MR branch: when a human reviewer's feedback on it is first assessed, rewrite the branch so each of its commits carries one `Co-authored-by: <name or login> <email>` trailer per person credited so far: on GitHub `<id>+<login>@users.noreply.github.com`, with the id from `gh api users/<login> --jq .id`; on GitLab the `public_email` from `glab api "users?username=<username>" --hostname <host>`, or none with the reviewer recorded in orchestrator_report when it is not public.
Withdraw auto-merge first as above.
Run `git fetch origin`, set `base=$(git merge-base HEAD origin/<base branch>)` with the base branch from `gh pr view <number> --json baseRefName` on GitHub or `glab mr view <number> --output json` on GitLab, and `old=$(git rev-parse origin/<head branch>)`, then run `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD` with one `--trailer` per person credited, which changes only commit messages, and push with `git push --force-with-lease=<head branch>:$old`; if the push is rejected, stop and report.
Commits you add later carry the same trailers.
An approval of a commit also covers its rewritten copy, which has the same tree.
If the PR/MR has merged, do not rewrite it; record the uncredited reviewer in orchestrator_report.
Never push an empty commit to credit a reviewer.
Do not credit bots (GitHub Apps whose logins end in [bot], GitLab bot and service accounts, and the accounts these instructions name as review bots), the PR/MR's author, the agent account, or the person these instructions name as commit author, who is already credited as the author of every commit.
Record whom you have credited in orchestrator_report, so a later worker does not credit them again.
If a human is working on the same problem and their branch or PR/MR contains this ticket's code (commits from the ticket branch, or its changes carried over), close this ticket's PR/MR immediately without asking anyone — `gh pr close <number>` on GitHub, `glab mr close <number> --hostname <host>` on GitLab — leaving one sentence on it that names the human's PR/MR.
Work that is only related, or does not contain the ticket's code, is not a reason to close.
Closing the PR/MR ends the ticket; send no other message.
