---
name: worktree-merge
description: Closes a spec implemented with /worktree-spec-impl. Run from the primary checkout, on the spec's base branch (develop, a task branch, main…). Verifies the branch already contains its base and is clean, fast-forwards the base to it, runs the checks, and cleans up the worktree, its database and its port. Integrates one branch at a time. Never pushes.
disable-model-invocation: true
argument-hint: <NN-spec-name>
allowed-tools: Bash(git status:*), Bash(git branch:*), Bash(git worktree:*), Bash(git rev-parse:*), Bash(git merge:*), Bash(git commit:*), Bash(git log:*), Bash(git merge-base:*), Bash(cat:*), Bash(ls:*), Bash(node ${CLAUDE_SKILL_DIR}/../worktree-spec-impl/scripts/*:*)
---

# /worktree-merge — Land a worktree branch on its base branch and clean up

This is the second half of `/worktree-spec-impl`. That skill leaves the spec's branch **already containing its base branch** and green (its Phase 5). This one does only what git forbids doing from inside the worktree — updating the base branch — plus the cleanup that `git merge` knows nothing about (worktree, database, port).

The **base branch** is whichever branch the worktree was created from and recorded in `.trees/registry.json` — `develop`, a task branch such as `feature/notifications`, or `main`. It is never assumed: this skill reads it, and lands the work there and nowhere else.

Conflict resolution does **not** happen here. It belongs in the worktree, where the agent that wrote the code has its own database and port to verify against. If the branch does not contain its base, this skill stops and sends you back.

**This skill never pushes and never opens a pull request.** It only updates a local branch.

## Session context

Current directory's toplevel:
!`git rev-parse --show-toplevel`

Primary checkout (first entry of the worktree list):
!`git worktree list --porcelain | head -1`

Current branch:
!`git branch --show-current`

Registered worktrees (each one records its `base`):
!`cat .trees/registry.json 2>/dev/null || echo "{} (no registry)"`

Uncommitted changes here:
!`git status --short`

---

## Instructions

Received argument: `$ARGUMENTS` (accepts `01-slug`, `01` or `slug`; the branch and worktree are `spec-<that>`). If empty, list the registered worktrees above and ask which one. Stop and wait.

Follow these steps in order. **Stop at the first one that fails; do not improvise around it.**

### 1. Preconditions

- **Must run from the primary checkout.** If the toplevel above is inside `.trees/`, stop: "Run this from the primary checkout, not from inside a worktree." Git cannot check the base branch out inside a worktree, because it is active in the primary checkout.
- The primary checkout must have **no uncommitted changes** (see above). Otherwise stop and ask the user to commit or stash them: a merge on top of a dirty tree mixes unrelated work.
- Resolve the slug to a registered worktree and confirm `.trees/spec-NN-slug` exists. If it is not in the registry, say so and stop.
- Read the state of the base branch instead of assuming it:

  ```
  node ${CLAUDE_SKILL_DIR}/../worktree-spec-impl/scripts/base.mjs spec-NN-slug
  ```

  It prints a JSON with `base`, `baseExists`, `primaryBranch`, `baseActiveInPrimary`, `containsBase`, `ahead`, `behind` and `originAhead`. If it exits non-zero, the message says why; the usual cause is a worktree created before the base branch was recorded — stop and ask the user which branch it should land on, and do not guess.
- `baseExists` must be `true`. If the base branch no longer exists, stop and tell the user.
- **`baseActiveInPrimary` must be `true`.** If it is `false`, stop with the exact command and touch nothing — switching branches with work in progress is the user's decision, not the skill's:

  ```
  ⛔ The base of spec-NN-slug is <base> and you are on <primaryBranch>.
     Run:  git switch <base>
     and launch /worktree-merge again.
  ```

### 2. The worktree must be finished

Check the worktree without entering it:

```
git -C .trees/spec-NN-slug status --short
```

Not empty → stop: the agent still has uncommitted work. Tell the user to finish or commit it in the worktree.

### 3. The branch must already contain its base

Use `containsBase` from step 1 (it is `git merge-base --is-ancestor <base> spec-NN-slug`).

- `true` → the branch contains the base, continue.
- `false` → the base has moved since Phase 5 (typically because another spec landed first). **Stop**:

  ```
  ⛔ spec-NN-slug does not contain the current <base>.
  Go back to the worktree and repeat Phase 5 of /worktree-spec-impl
  (merge <base> into the branch, resolve conflicts, checks green), then run this again.
  ```

  Do not merge the base into the branch from here and do not resolve conflicts here.

### 4. Land it

Ask the user how to land it, with `AskUserQuestion`:

```
How do I land spec-NN-slug on <base>?
  1) --ff-only   (default — step-by-step history, no merge commit)
  2) --no-ff     (an explicit merge commit)
  3) --squash    (every commit of the spec collapsed into one on top of <base>)
```

Step 3 already guarantees `containsBase` is `true` in all three cases, so none of them can lose anything from the base.

- **`--ff-only`** (default):

  ```
  git merge --ff-only spec-NN-slug
  ```

  This runs in the primary checkout, which is on `<base>`. `--ff-only` is the point: it is guaranteed possible by step 3, and if it is not, something changed between the check and now — fail loudly instead of creating a surprise merge commit.

- **`--no-ff`**:

  ```
  git merge --no-ff spec-NN-slug
  ```

  Follow the commit rule from `/worktree-spec-impl` (show the proposed message, in Conventional Commits/English, before committing — `git merge --no-ff` opens the message for you, so propose it as the default and let the user accept, edit, or replace it).

- **`--squash`**:

  ```
  git merge --squash spec-NN-slug
  ```

  This stages everything but does **not** commit. Follow the commit rule from `/worktree-spec-impl`: propose a message (default `feat(spec-NN): <the spec's objective line>`, read from `specs/NN-slug.md`), then `git commit` with what the user approves.

If `originAhead` was greater than `0`, mention it in any case: `origin/<base>` has commits the local base did not, so a later `git push` will need a pull or rebase. Do not fetch, pull or push for the user.

### 5. Last safety net on the base

Run `node ${CLAUDE_SKILL_DIR}/../worktree-spec-impl/scripts/verify.mjs` in the primary checkout (it runs whatever `test`, `lint` and `typecheck` the project defines). If it is red, **do not clean up**: report it. The worktree and branch are still there to fix it; the base branch can be reset by the user with `git reset --hard ORIG_HEAD` only if they ask for it — never do that yourself.

### 6. Clean up

Only when the checks are green, and after telling the user exactly what will be removed (the worktree directory, its database, its port entry) and getting a yes:

```
node ${CLAUDE_SKILL_DIR}/../worktree-spec-impl/scripts/teardown.mjs spec-NN-slug
```

It drops this worktree's database, removes the worktree and frees its registry entry. The database drop has three guards: it only drops a database the skill itself created, never the project's base database, and only if the name is exactly the one derived for this slug. If a guard refuses, it says so and keeps the database — tell the user, do not work around it. Then delete the merged branch:

```
git branch -d spec-NN-slug
```

`-d`, not `-D`: git refuses if the branch is not fully merged, which is the safety we want. If it refuses, report it and do not force.

**Exception — after `--squash` in step 4:** git never records the branch as merged for a squash (there is no merge commit pointing at it), so `git branch -d` will always refuse even though the content is safely on `<base>`. This is the **only** case where you force-delete, and only after explaining it and getting an explicit yes:

```
The content of spec-NN-slug is on <base> as commit <sha> (squashed). Delete the branch
with git branch -D spec-NN-slug? [y/N]
```

Only on an explicit yes: `git branch -D spec-NN-slug`. With `--ff-only` or `--no-ff`, never force — use plain `-d` as above.

### 7. Report and chain

```
✅ spec-NN-slug landed on <base> and was cleaned up.   (nothing was pushed)

Removed:   .trees/spec-NN-slug, database <name>_spec_NN_slug, port 3001
```

If `<base>` is a **task branch** (not the branch the user normally integrates into), say so: the work is now on that branch, and taking that branch to `develop` (or wherever it goes) is the user's usual flow, not something this skill does.

If other worktrees with the **same base** are still registered, list them and remind the user that **each one must repeat Phase 5** of `/worktree-spec-impl` against the updated `<base>` before it can be landed. Worktrees with a different base are not affected. Integrate them one at a time, never in parallel.
