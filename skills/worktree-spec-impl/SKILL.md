---
name: worktree-spec-impl
description: Implements an approved spec in an isolated git worktree so several agents can work in parallel. Validates that the state means "Approved" (in any language), creates .trees/spec-NN-slug from the current branch (develop, a task branch, main… or --base), bootstraps it (ignored files, node_modules, own port and database), implements step by step with pauses to review diffs, and finally merges the base branch into the spec's branch resolving conflicts so it is ready for /worktree-merge.
disable-model-invocation: true
argument-hint: <NN-spec-name> [--base <branch>]
allowed-tools: Bash(git status:*), Bash(git branch:*), Bash(git worktree:*), Bash(git rev-parse:*), Bash(git fetch:*), Bash(git merge:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(mkdir:*), Bash(cat:*), Bash(ls:*), Bash(node ${CLAUDE_SKILL_DIR}/scripts/*:*), EnterWorktree, ExitWorktree
---

# /worktree-spec-impl — Implementer of approved specs, in an isolated worktree

## Session context

Current repository state:
!`git status --short`

Current branch:
!`git branch --show-current`

Repository root:
!`git rev-parse --show-toplevel`

Specs available in this folder:
!`ls specs/ 2>/dev/null || echo "The specs/ folder does not exist"`

Branch-creation config:
!`cat specs/.spec-config.yml 2>/dev/null || echo "AutoCreateBranch: true (default, no config file)"`

Existing worktrees:
!`git worktree list`

.trees/ folder status:
!`ls -d .trees 2>/dev/null || echo ".trees/ does not exist yet"`

Worktrees already registered (port and database each one owns):
!`cat .trees/registry.json 2>/dev/null || echo "{} (no registry yet)"`

---

## Instructions

Follow these phases in strict order (0, 1, 2, 3, 3.5, 4, 5). **Do not advance to the next phase if the previous one did not complete correctly.**

This skill behaves like `/spec-impl`, with one structural difference: instead of creating a branch and switching the *current* checkout to it, it creates a **git worktree** — a separate working directory with its own checkout of the new branch — under `.trees/` at the repository root, and moves the session into that worktree. Your original checkout is left completely untouched.

It is designed so that **two or more agents can run this skill at the same time**, each on a different spec, without affecting each other. Git only isolates *tracked files*; everything else a project needs at runtime is isolated by `scripts/bootstrap.mjs`: ignored files (`.env`, `node_modules/`) are copied/cloned in, the TCP port is allocated atomically in `.trees/registry.json`, and each worktree gets its own database via the project's own driver (no `psql`/docker needed). Infrastructure containers are **not** duplicated — shared, started only from the primary checkout.

**It works on any Node project (TypeScript or JavaScript) and on any OS** — the scripts are plain Node (`.mjs`), no dependency on `bash`/`jq`/`flock`/`sed`. Everything project-specific is **autodetected**: package manager from the lockfile (npm/pnpm/yarn/bun), env files to copy from what's git-ignored (`.env*`, templates like `.env.example` excluded; if the main one isn't literally `.env`, Phase 3.5 asks and records it), the port variable (`APP_PORT`/`PORT`/`SERVER_PORT`/`HTTP_PORT`), the database (a URL var like `DATABASE_URL` or loose vars like `DB_NAME`; engine from the URL scheme or the installed driver), and verification steps from `package.json` scripts (`test`, `lint`, `typecheck`).

`.claude/worktree.json` is **optional** and only holds what cannot be detected: `copy` (extra files), `portVars`, `envFile`, `db` (`{engine, urlVar, nameVar, pgBin, skip}`: override detection, point to the PostgreSQL client folder on Windows, or `skip` provisioning), and `setup[]` / `teardown[]` (extra shell steps, e.g. Redis). On a new machine or project, run `/worktree-doctor` first: it reports what will work and what will not, before anything is created.

---

### The base branch

Every worktree has a **base branch**: the branch it is created from and, at the end, the branch its work lands on. It is **not** assumed to be `main`.

- By default the base is **the branch that is active in the primary checkout when you launch the skill** (the "Current branch" shown above): `develop`, a task branch like `feature/notifications`, or `main`.
- `--base <branch>` overrides it, so a worktree can be created from a local branch that is not the active one. `HEAD` detached and no `--base` → stop and ask for it.
- It is captured **once**, at creation, and recorded in `.trees/registry.json` (`base`). It is never re-derived afterwards: the active branch of the primary checkout can change between sessions, and other agents may be using it.
- The worktree is always created with the base as an **explicit start point** (`git worktree add … <base>`), so it starts from the base even if the primary checkout has since moved to another branch.
- Several worktrees may have different bases at the same time (say `develop` and `feature/notifications`). They do not interfere with each other.

---

### Phase 0 — Scope collision check (informational, never blocks)

Before creating anything, read the registry shown above. For every worktree already registered **with the same `base`**, read its spec's **scope** section (`specs/<slug>.md`) and compare the files/modules it claims against the ones the new spec claims. Worktrees with a different base are skipped: they converge on a different branch, so they are not necessarily going to conflict.

If they overlap, warn now, before any work exists:

```
⚠ Scope overlap with spec-02-powerups (in progress):
   both touch src/domain/services/ticket.service.ts
   Expect a conflict when integrating the second one. Continue? [Y/n]
```

Overlap is not an error — the merge in Phase 5 exists to handle it — but the user should know, and may prefer to sequence the two specs instead. Wait for an answer only if there is an overlap. Skip this phase silently when the registry is empty.

The new spec and its base are only known after Phase 1, so run this check right after Phase 1 identifies them, and before Phase 2 continues.

---

### Phase 1 — Identify the spec

The received argument is: `$ARGUMENTS`

It has the form `<spec> [--base <branch>]`. Split off `--base <branch>` first if present (the value is the next word); what remains is the spec name. Remember the value: it is the **base branch** for Phase 3. If `--base` is absent, the base is the current branch shown in the session context.

If the spec part of `$ARGUMENTS` is empty:

- List the files available in `specs/` (you already have them above).
- Ask the user to specify the exact name of the spec.
- Stop and wait for an answer. Do not continue.

If the spec part has a value:

- Look for the file in `specs/`. The user may have written the full name (`01-mvp-arkanoid`), only the number (`01`), or only the slug (`mvp-arkanoid`). Try to find the correct file in any of those cases.
- If you do not find the file, show the available specs and ask the user to correct the name.
- If you do find it, continue to Phase 2.

---

### Phase 2 — Validate the spec's state

Read the spec file you located in Phase 1 using the Read tool or `cat`.

In the file's contents, look for the line that contains the spec's state. The header label is typically `**Status:**` (English) or `**Estado:**` (Spanish), but it may use any language. Match by position (status line near the top of the spec) and by the surrounding state machine, not by the exact label.

**Absolute rule:** You can only continue if the state **means "Approved"** — regardless of the language used.

Treat any of the following (and their equivalents in other languages) as the **Approved** state and continue:

- English: `Approved`
- Spanish: `Aprobado`
- Portuguese: `Aprovado`
- French: `Approuvé`
- German: `Genehmigt`
- Italian: `Approvato`
- …or any other language's word that clearly means "approved"

Anything else — Draft/Borrador, In review/En revisión, Implemented/Implementado, Obsolete/Obsoleto, a state line not found, or any unrecognized value — means **stop** and show the error message below.

If you are unsure whether a value means "approved", **do not assume**. Stop and ask the user to clarify or to update the spec to the canonical wording.

**Standard error message when the state does not mean Approved:**

```
❌ I cannot implement this spec.

Current state: [STATE FOUND]
I only work with specs whose state means "Approved" (e.g. `Approved`, `Aprobado`,
or the equivalent in another language).

To continue you have two options:
  1. If the spec is ready to be implemented, open it and change the state
     to "Approved" (or the equivalent term your team uses) manually.
     That change is made by the human, not the agent.
  2. If the spec still needs work, use /spec [name] to resume it.
```

Do not offer alternatives, do not suggest "I can still start if you want". The block is intentional.

---

### Phase 3 — Create the worktree (inside `.trees/`) and enter it

Once you have confirmed the state means `Approved`:

1. Derive the branch/worktree name from the spec file's full name, without the extension. Format: `spec-NN-slug`. Examples:

   - `01-mvp-arkanoid.md` → `spec-01-mvp-arkanoid`
   - `02-powerups.md` → `spec-02-powerups`

2. Read the `AutoCreateBranch` flag from the **Branch-creation config** shown in the session context above (the flag name is reused as-is; it now governs automatic *worktree* creation instead of a plain branch checkout).

   - If the config file does not exist, the value is missing, or the value is unrecognized → treat it as `true` (the default).
   - Only an explicit `false` (in any capitalization) disables automatic creation.

3. Ensure the `.trees/` folder exists at the **repository root** (the path printed above as "Repository root"). If `.trees/` does not exist, create it yourself with `mkdir -p .trees` before creating the worktree — do not ask the user to create it.

   If `.trees/` is untracked and there is no `.trees/` (or `.trees`) entry in the repository's `.gitignore`, add one. A worktree directory should never be committed into the primary checkout. Just edit the file — do not commit it on the user's behalf.

4. Determine the target worktree path: `.trees/spec-NN-slug` (relative to the repository root).

   **If `AutoCreateBranch` is `true` (default):** proceed without asking.

   - If neither the worktree path nor the branch already exists: create both in one step, starting **explicitly from the base branch**:
     `git worktree add .trees/spec-NN-slug -b spec-NN-slug <base>`
     where `<base>` is `--base` if it was given, otherwise the current branch from the session context. If `HEAD` is detached and there is no `--base`, stop and ask the user for the base branch. The base must be a **local** branch that exists.
   - If the worktree path **already exists** (check `git worktree list` from the session context, refreshed if needed): inform the user that this worktree already existed (it may mean previous work is being resumed). Do not recreate it. Its base is the one already recorded in the registry; if the user passed a different `--base`, tell them it is ignored and why.
   - If the **branch** already exists but the worktree does not: create the worktree checking out the existing branch with
     `git worktree add .trees/spec-NN-slug spec-NN-slug` (no `-b`, no start point). Its base is the one recorded in the registry; if there is none, pass `--base` to the bootstrap.
   - In all cases, once the worktree exists on disk, switch the session into it using `EnterWorktree` with `path: .trees/spec-NN-slug` (relative or absolute, resolved from the repository root). Confirm the switch succeeded before continuing.

   **If `AutoCreateBranch` is `false`:** ask before touching git. Show:

   ```
   AutoCreateBranch is set to false.
   Create the worktree .trees/spec-NN-slug on branch spec-NN-slug and switch into it? [y/N]
   ```

   - If the user answers **yes**: create/enter the worktree exactly as in the `true` case above.
   - If the user answers **no** or leaves it empty: **do not create any worktree.** Tell the user you will implement on the current checkout/branch (the one shown in the session context above) and ask for explicit confirmation to continue there. Do not improvise — wait for the answer.

5. If you are now inside the worktree, continue to Phase 3.5. If no worktree was created (the user declined), skip Phase 3.5 and go straight to the confirmation box and spec summary described there, showing the current checkout instead of a worktree; Phase 5 then does not apply.

---

### Phase 3.5 — Bootstrap the worktree

A fresh worktree only contains tracked files. It has no `node_modules/`, no `.env`, and would share its port and database with every other worktree. Fix that before touching any code.

1. Run the bootstrap script from inside the worktree (the second argument is the worktree name, `spec-NN-slug`; **always pass `--base` with the base branch you created it from**, so it is recorded explicitly instead of being guessed):

   ```
   node ${CLAUDE_SKILL_DIR}/scripts/bootstrap.mjs . spec-NN-slug --base <base>
   ```

   It is idempotent, so it is safe to re-run on a resumed worktree. It:
   - validates and records the base branch in the registry (once recorded it cannot be changed by passing a different `--base`);
   - copies the git-ignored `.env*` files (plus any `copy[]` in `worktree.json`) without overwriting existing ones;
   - installs dependencies (hardlinked from the primary checkout's `node_modules` when possible, otherwise a normal install with the detected package manager);
   - allocates a free port under a lock in `.trees/registry.json` and rewrites it into the worktree's `.env`;
   - gives the worktree **its own exact copy (schema and data) of the database named in the `.env`** — never empty, never shared: either the copy succeeds or the bootstrap fails. It picks the fastest method the engine allows (e.g. Postgres `TEMPLATE`, falling back to `pg_dump | psql` if the base has open connections); a project with no database gets nothing provisioned, which is not an error;
   - runs the project's `setup[]` steps, if any;
   - prints a JSON on stdout with `base`, `port`, `db`, `dbMethod` (`template` | `dump` | `copy` | `existing` | `none`), `dbWarnings`, `install` and `packageManager`.

   The copy is a **snapshot taken at bootstrap time**. If another spec later lands a migration on the base branch, this worktree's database does not have it: Phase 5 covers that. If `dbMethod` is `copy` (MySQL/MongoDB), mention to the user that this path is less battle-tested than the Postgres one.

   **Exit code 3 is not a failure.** It means the user must decide something before anything was created, and stdout tells you which case (`reason`):

   - **`remote-db`**: the database in the `.env` is **remote** (not localhost). stdout is `{"status":"needs-confirmation","reason":"remote-db","host":…,"engine":…,"database":…}`. Ask the user with `AskUserQuestion`: *"The database in the .env is remote (`<host>`). Cloning it copies its real data into another database on the same server, with cost and possibly sensitive data. Continue?"* If **yes**, re-run the same command adding `--confirm-remote`. If **no**, stop and offer to undo the worktree (`node ${CLAUDE_SKILL_DIR}/scripts/teardown.mjs spec-NN-slug`, from the primary checkout); do **not** offer to carry on without isolation, because the worktree's `.env` would still point at the shared database. Never add `--confirm-remote` on your own.

   - **`no-env-file`**: the project has no `.env` at the repository root. stdout is `{"status":"needs-confirmation","reason":"no-env-file","expected":".env","candidates":[...]}`. Without the real file name, port and database detection silently read an empty map and the worktree ends up sharing the primary checkout's port and database. Never let that pass unnoticed. Ask the user with `AskUserQuestion` which file it really is, offering `candidates` (files found that look like an env file and are git-ignored) plus a free-text option for another name.

     - If they name a file: write `{"envFile": "<name>"}` into `.claude/worktree.json` **in the primary checkout**, merging with whatever is already there (create the file if it does not exist) — this is required, not optional: `db.mjs`, `doctor.mjs` and especially `teardown.mjs` all read `config.envFile` independently later, and without this entry `teardown.mjs` would not know which database to drop. Then re-run the same bootstrap command adding `--env-file <name>`.
     - If they say the project truly has no env file: say plainly that the worktree will have **no port and no database of its own** and will share the primary checkout's, and ask for explicit confirmation before continuing that way. If they decline, offer to undo the worktree with `teardown.mjs` as above.

   If it exits with any other non-zero code, **stop**, show the error to the user and do not continue. The messages say what to do. The usual causes are a database server that is not running (start it from the **primary checkout**, never from the worktree), a database user without `CREATEDB`, or, on Postgres with the base in use, a missing `pg_dump`/`psql` client.

2. **Verify the environment really works** before implementing:

   ```
   node ${CLAUDE_SKILL_DIR}/scripts/verify.mjs
   ```

   It runs only the checks the project defines (`test`, `lint`, `typecheck`) and exits non-zero if any fails. A red baseline means the bootstrap is wrong or the base branch is already broken — either way, the user must know before any code is written. Do not continue on a red baseline.

3. Visually confirm to the user the spec is ready, which worktree is active and the resources it owns:

   ```
   ✅ Ready to implement.

   Spec:      specs/NN-slug.md          Port:      3001   (isolated)
   Worktree:  .trees/spec-NN-slug       Database:  <name>_spec_NN_slug   (isolated, exact copy of the base)
   Branch:    spec-NN-slug              State:     Approved   (← echo the actual value found in the spec)
   Base:      <base>                    (the branch it was created from and will land on)
   ```

   Show the database line only if `db` is not null, and say **how** it was obtained (`dbMethod`: `template` and `dump` are exact copies; `copy` is the driver-based copy of MySQL/MongoDB/SQLite; `existing` means a previous run's copy was reused), plus any `dbWarnings` (e.g. MySQL views or triggers that were not copied). (If no worktree was created, show the current checkout and branch and omit Port/Database.)

4. **Do not start implementing yet.** First show the spec summary to the user so they have it fresh. Extract and show:
   - The **objective** (the line after `**Objective:**` / `**Objetivo:**` / equivalent label).
   - The **scope** (the `## Scope` / `## Alcance` / equivalent section).
   - The **implementation plan** (the section with the numbered steps — `## Implementation plan` / `## Plan de implementación` / equivalent).
   - The **acceptance criteria** (the checklist — `## Acceptance criteria` / `## Criterios de aceptación` / equivalent).

Match section headings by meaning, not by exact wording — the spec may be authored in any language.

---

### Commit rule (applies to every `git commit` from here on)

**Never run `git commit` with a message you have not shown first.** Before each commit:

1. Summarize in one line what goes into the commit — files and intent, read from the actual diff, not from the plan.
2. Propose a message in **Conventional Commits, in English** (`feat(scope): …`, `fix`, `refactor`, `chore`, `test`, `docs`). Subject ≤ 72 characters, imperative mood, no trailing period. A body only when the *why* is not obvious from the subject.
3. Present it with `AskUserQuestion`: **"Use this message" / "Edit it" / "I'll write my own"**.
4. Wait for the answer. Do not commit without it.
5. For the integration commit in Phase 5, the default subject is `chore(merge): integrate <base> into spec-NN-slug`.

Messages still carry whatever attribution lines this environment already appends. Never `push`, never `--no-verify`.

---

### Phase 4 — Implement step by step (inside the worktree)

After showing the spec summary, tell the user:

```
I am going to implement the spec following the implementation plan exactly,
working inside the .trees/spec-NN-slug worktree.
I will pause after each step so you can review the diff.

Shall we start with Step 1?
```

Wait for explicit confirmation ("yes", "go ahead", "go", or equivalent). Do not start without it.

Once confirmed, follow these rules during the entire implementation:

**Isolation rules (they exist because other agents are running at the same time):**

- Use **only** the port and database assigned in Phase 3.5 (they are in this worktree's `.env`). Never hardcode or fall back to the primary checkout's port or database, and never run anything against them.
- **Never start, stop or recreate shared infrastructure from the worktree** (`docker compose up`, a database server, a queue). Compose derives its project name from the folder name, so running it here would create a second container and volume instead of reusing the shared one. Infrastructure is started from the primary checkout only; the worktree just connects to it.
- **Never drop, reset or truncate the database by hand outside the worktree's own** (`DB_NAME` in this worktree's `.env`). The base database belongs to the user and to the other agents' clones.
- Do not edit files outside this worktree, and do not touch other worktrees under `.trees/`.
- Do not commit `.env`, `node_modules/` or anything under `.trees/`.

**One rule above all:** implement what the spec says. If something in the spec looks suboptimal to you, mention it as an observation but implement what was agreed. Changes to the spec go into the spec, not into the code by surprise.

**Work rhythm:**

- Implement one step of the plan (all file edits happen inside the active worktree).
- Show a summary of which files you touched and what you did.
- Say: `Step N completed. Could you review the diff and let me know if I continue with Step N+1?`
- Wait for confirmation before continuing.

**If during the implementation you find an ambiguity** the spec does not resolve:

- Stop.
- Describe the ambiguity exactly.
- Present two or three concrete options.
- Wait for the user's decision.
- Do not improvise.

**If the user asks for something that is out of the spec's scope:**

- Remind them that it is out of this spec's scope.
- Suggest noting it down for the next spec.
- Do not implement it on this worktree.

**When finishing the last step:**

```
✅ All steps of the plan are implemented.

Next step: verify the spec's acceptance criteria one by one.
If they all pass, update the spec's state to "Implemented" (or the equivalent
in your repo's language) and commit (see the commit rule above — I will show you
the message first). Then I integrate the base branch (<base>) into
this branch (Phase 5).
```

Do not remove the worktree or use `ExitWorktree` with `action: "remove"` unless the user explicitly asks for it — leaving it in place preserves the work and lets the user return to it later.

---

### Phase 5 — Integrate the base branch into the spec's branch (still inside the worktree)

Run this only after the acceptance criteria pass and the work is committed. Ask the user to confirm ("Shall I integrate `<base>` into this branch now?") — other specs may have landed on the base since you started.

The base is the one recorded at creation (`develop`, a task branch, `main`…). Never assume it: read it with

```
node ${CLAUDE_SKILL_DIR}/scripts/base.mjs spec-NN-slug
```

(read-only; it works from inside the worktree). It prints `base`, `containsBase`, `ahead`, `behind`, `originAhead`, `primaryBranch` and `baseActiveInPrimary`. If it exits non-zero, show the message and stop: the usual cause is a worktree created before the base was recorded, and the user must say which branch it lands on.

**Why the direction matters:** the base branch is checked out in the primary checkout, and git refuses to check out the same branch in two worktrees. From here you **cannot** merge into the base; you can only bring the base *into* your branch. That is the right place anyway: conflicts are resolved where the context is, with this worktree's own database and port to verify against, so what finally reaches the base is already integrated and green.

1. Make sure the working tree is clean (`git status --short`). Commit (per the commit rule above) or stash anything pending.
2. `git fetch`, then run `base.mjs` again and look at `originAhead`. If it is greater than `0`, `origin/<base>` has commits that the **local** `<base>` does not: tell the user and suggest running `git pull` on `<base>` in the primary checkout first, then repeating this phase. **Do not merge the remote branch yourself**: the final fast-forward lands on the local base, so merging `origin/<base>` would drag remote commits into the user's local branch without them having pulled.
3. `git merge <base>` (the **local** branch). Use **merge, not rebase**: it keeps the step-by-step history the user reviewed in Phase 4 and does not rewrite commits.
4. If there are conflicts, follow `${CLAUDE_SKILL_DIR}/reference/conflicts.md`. In short: never resolve a lockfile by hand, keep both sides of composition roots, check migration ordering, and for a real semantic conflict (both specs change the same rule incompatibly) **stop and present two or three options** — do not decide alone.
5. If the merge changed `package.json` / the lockfile, reinstall with the project's package manager (`npm ci`, `pnpm install`, `yarn install` or `bun install`; bootstrap skips installing when `node_modules` already exists, so re-running it does not help). If the base added migrations, re-run them against this worktree's database. If the base added a required env var, add it to this worktree's `.env` by hand: it is gitignored and never updates itself.
6. Verify the integrated result, not just that it merged: `node ${CLAUDE_SKILL_DIR}/scripts/verify.mjs` (the project's own `test`, `lint` and `typecheck`), and then the flow against the real server on this worktree's own port. A conflict-free merge can still be semantically broken.
7. Commit the merge if git did not (e.g. after resolving conflicts by hand — follow the commit rule above; git's own default merge message is fine as the proposed one), then run `base.mjs` one last time and check that `containsBase` is `true`.

Finish with:

```
✅ Branch spec-NN-slug now contains <base> and is green.

Next step, from the primary checkout (not from here), with <base> active there:
  git switch <base>            (only if it is not the active branch)
  /worktree-merge NN-slug
It fast-forwards <base> to this branch and cleans up the worktree, its database and its port.
Nothing is pushed. If another spec lands on <base> first, come back here and repeat Phase 5.
```

Do not try to merge into the base from the worktree, and do not remove the worktree, its database or its registry entry yourself — `/worktree-merge` does that.

**Worktree creation is controlled by the `AutoCreateBranch` flag** in `specs/.spec-config.yml` (same flag `/spec-impl` uses). It defaults to `true` (create `.trees/spec-NN-slug` and switch into it automatically). Set it to `false` to make Phase 3 ask `[y/N]` before creating the worktree.
