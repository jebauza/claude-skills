---
name: worktree-spec-impl
description: Implements an approved spec. Validates that the state means "Approved" (in any language), creates a dedicated git worktree (inside .trees/) named after the spec instead of switching branches in place, enters it, and starts the implementation step by step with pauses to review diffs.
disable-model-invocation: true
argument-hint: <NN-spec-name>
allowed-tools: Bash(git status:*), Bash(git branch:*), Bash(git worktree:*), Bash(git rev-parse:*), Bash(mkdir:*), Bash(cat:*), Bash(ls:*), EnterWorktree, ExitWorktree
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

---

## Instructions

Follow these four phases in strict order. **Do not advance to the next phase if the previous one did not complete correctly.**

This skill behaves exactly like `/spec-impl`, with one structural difference: instead of creating a branch and switching the *current* checkout to it, it creates a **git worktree** — a separate working directory with its own checkout of the new branch — under `.trees/` at the repository root, and moves the session into that worktree. Your original checkout is left completely untouched.

---

### Phase 1 — Identify the spec

The received argument is: `$ARGUMENTS`

If `$ARGUMENTS` is empty:

- List the files available in `specs/` (you already have them above).
- Ask the user to specify the exact name of the spec.
- Stop and wait for an answer. Do not continue.

If `$ARGUMENTS` has a value:

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

Anything else (Draft / Borrador, In review / En revisión, Implemented / Implementado, Obsolete / Obsoleto, or any unrecognized value) means **stop** and show the error message below.

| State category                            | Examples (any language)                           | Action                                                                     |
| ----------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| Approved                                  | `Approved`, `Aprobado`, `Aprovado`, `Approuvé`, … | Continue to Phase 3.                                                       |
| Draft                                     | `Draft`, `Borrador`, …                            | Stop. Show the error message below.                                        |
| In review                                 | `In review`, `En revisión`, …                     | Stop. Show the error message below.                                        |
| Implemented                               | `Implemented`, `Implementado`, …                  | Stop. Show the error message below.                                        |
| Obsolete                                  | `Obsolete`, `Obsoleto`, …                         | Stop. Show the error message below.                                        |
| State line not found / unrecognized value | —                                                 | Stop. The file does not follow the expected format. Tell this to the user. |

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

   If `.trees/` is untracked and there is no `.trees/` (or `.trees`) entry in the repository's `.gitignore`, add one. A worktree directory should never be committed into the main checkout. Just edit the file — do not commit it on the user's behalf.

4. Determine the target worktree path: `.trees/spec-NN-slug` (relative to the repository root).

   **If `AutoCreateBranch` is `true` (default):** proceed without asking.

   - If neither the worktree path nor the branch already exists: create both in one step with
     `git worktree add .trees/spec-NN-slug -b spec-NN-slug`.
   - If the worktree path **already exists** (check `git worktree list` from the session context, refreshed if needed): inform the user that this worktree already existed (it may mean previous work is being resumed). Do not recreate it.
   - If the **branch** already exists but the worktree does not: create the worktree checking out the existing branch with
     `git worktree add .trees/spec-NN-slug spec-NN-slug` (no `-b`).
   - In all cases, once the worktree exists on disk, switch the session into it using `EnterWorktree` with `path: .trees/spec-NN-slug` (relative or absolute, resolved from the repository root). Confirm the switch succeeded before continuing.

   **If `AutoCreateBranch` is `false`:** ask before touching git. Show:

   ```
   AutoCreateBranch is set to false.
   Create the worktree .trees/spec-NN-slug on branch spec-NN-slug and switch into it? [y/N]
   ```

   - If the user answers **yes**: create/enter the worktree exactly as in the `true` case above.
   - If the user answers **no** or leaves it empty: **do not create any worktree.** Tell the user you will implement on the current checkout/branch (the one shown in the session context above) and ask for explicit confirmation to continue there. Do not improvise — wait for the answer.

5. Visually confirm to the user the spec is ready and which worktree is active:

   ```
   ✅ Ready to implement.

   Spec:      specs/NN-slug.md
   Worktree:  .trees/spec-NN-slug  (active)   (← or the current checkout, if no worktree was created)
   Branch:    spec-NN-slug
   State:     Approved   (← echo back the actual value found in the spec)
   ```

6. **Do not start implementing yet.** First show the spec summary to the user so they have it fresh. Extract and show:
   - The **objective** (the line after `**Objective:**` / `**Objetivo:**` / equivalent label).
   - The **scope** (the `## Scope` / `## Alcance` / equivalent section).
   - The **implementation plan** (the section with the numbered steps — `## Implementation plan` / `## Plan de implementación` / equivalent).
   - The **acceptance criteria** (the checklist — `## Acceptance criteria` / `## Criterios de aceptación` / equivalent).

Match section headings by meaning, not by exact wording — the spec may be authored in any language.

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
in your repo's language) and make the final commit before merging this branch.

This work lives in the .trees/spec-NN-slug worktree on branch spec-NN-slug.
When you are done, you (or I, if you ask) can merge the branch and remove the
worktree with `git worktree remove .trees/spec-NN-slug` — the worktree does not
disappear automatically.
```

Do not remove the worktree or use `ExitWorktree` with `action: "remove"` unless the user explicitly asks for it — leaving it in place preserves the work and lets the user return to it later.

---

## Summary of expected behavior

```
/worktree-spec-impl 01-mvp-arkanoid

  Phase 1  →  Finds specs/01-mvp-arkanoid.md
  Phase 2  →  Reads the state → "Approved" (or "Aprobado", etc.) → ✅ continues
  Phase 3  →  mkdir -p .trees (if missing)
              git worktree add .trees/spec-01-mvp-arkanoid -b spec-01-mvp-arkanoid
              EnterWorktree path: .trees/spec-01-mvp-arkanoid
              Shows objective, scope, plan and criteria
  Phase 4  →  Implements step by step with pauses, inside the worktree
              Ends by reminding to verify acceptance criteria and how to clean up the worktree

/worktree-spec-impl 02-powerups  (state: Draft / Borrador)

  Phase 1  →  Finds specs/02-powerups.md
  Phase 2  →  Reads the state → "Draft" → ❌ stops
              Shows the standard error message
              Does not create a worktree, does not touch code
```

**Worktree creation is controlled by the `AutoCreateBranch` flag** in `specs/.spec-config.yml` (same flag `/spec-impl` uses). It defaults to `true` (create `.trees/spec-NN-slug` and switch into it automatically, as shown above). Set it to `false` to make Phase 3 ask `[y/N]` before creating the worktree.
