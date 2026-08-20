---
name: refine-memory
description: Read-repair for one memory in the Codebase Cognitive Memory graph (cuonghuunguyen/claude-notebook, spec.md §24.2.4 / ROADMAP.md M13). Takes a memory the staleness pass has flagged `possibly-stale`, reads its anchored files and the git log since it was written, and settles it — either recording a correction that supersedes it, or confirming it is still accurate and clearing the mark. Use when `self-memory.mjs ask` returns a hit tagged possibly-stale and names this skill, when asked to repair/refine/verify a memory or to work through the suspect backlog, or when a memory's advice contradicts what the code actually does now.
---

# refine-memory

Read-repair. A memory that history has overtaken gets *settled* here, at the
moment somebody is reading it — not by a background rescan, and not by
deletion.

You were probably sent here by `self-memory.mjs ask`, which prints
`/refine-memory <id>` under any hit it flagged. You can also be pointed at the
backlog with no id.

## Why this exists (read this before deciding anything)

M12 made memories falsifiable: a commit touching a memory's anchored paths
marks it `suspect`. Dogfooded on this repository that pass flagged **24 of 27
memories** — because capture anchors a mined memory to *every* file its commit
touched, which here includes `ROADMAP.md`, `CHAIN_LOG.md` and `BENCHMARKS.md`,
files almost every later commit also touches.

So the base rate matters: **most flags are false.** A flag means "a file this
memory mentions has changed", never "this memory is wrong". Your job is to find
out which, by reading. If you supersede memories on the strength of the flag
alone you will replace accurate knowledge with worse knowledge and the graph
gets *less* trustworthy, not more.

The inverse failure is just as real: confirming a memory you did not actually
check makes the flag permanently unavailable for that memory until the next
commit touches it. Do not verify to clear a backlog.

## Preconditions

`DATABASE_URL` must be set (the SessionStart hook does this) and the packages
must be built (`pnpm -r build`) — `self-memory.mjs` loads `dist/`, not `src/`.

## Steps

1. **Pick the memory.**
   - Given an id: `node scripts/self-memory.mjs show <id>`.
   - Given nothing: `node scripts/self-memory.mjs suspects` lists the flagged
     memories oldest-first (most history has piled up on those, so they are the
     likeliest to be genuinely wrong). Pick one. Do **not** try to work through
     the whole list in one session — one memory, settled properly, is the unit
     of work here.

   `show` gives you the memory's full text, its `anchors`, its `timestamp`, its
   `suspectReason`, and its supersede chain if it has one. Stop and re-read the
   `observation` in full. You are about to judge whether it is true.

2. **Stamp the instant you start reading.**
   ```bash
   READ_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   ```
   Keep it. If you end up verifying (step 7) you pass this, not the time you
   finish — otherwise you would be claiming to have checked against commits
   that landed while you were thinking, and those commits could then never
   re-raise the flag.

3. **Read what the memory actually claims.** Write down, for yourself, the
   specific falsifiable claim(s). "`byMeaning` fuses three legs by weighted RRF"
   is checkable. "The retrieval design is good" is not — a memory with no
   checkable claim cannot be repaired, only left alone (step 7).

4. **Read the current code at the anchors.** Actually open every anchored path.
   If the anchor names a symbol, find that symbol — it may have moved; anchors
   are text precisely so a moved symbol is re-found lexically rather than by a
   dead line number.

   An anchored path that no longer exists is a signal, not a verdict: it may
   have been renamed (check `git log --follow`).

5. **Read the history that raised the flag.**
   ```bash
   git log --oneline --since=<memory timestamp> -- <anchored paths>
   git log -p --since=<memory timestamp> -- <the anchor that matters most>
   ```
   The `suspectReason` names the specific commit. Read that commit. Very often
   it touched `ROADMAP.md` and nothing the memory actually talks about, and you
   are done in one look.

6. **Decide, and be honest about which of the three you are in.**

   | What you found | Outcome |
   |---|---|
   | The claims still hold — the commits touched other things | **Verify** (step 7) |
   | A claim is now wrong, and you know what replaced it | **Supersede** (step 8) |
   | A claim is wrong and you cannot establish what is true now | **Neither** — leave the flag up and say so |

   The third row is a real outcome, not a failure. A flag left standing is
   correct information; a confident wrong correction is not.

7. **Verify — the memory is still accurate.**
   ```bash
   node scripts/self-memory.mjs verify <id> "$READ_AT"
   ```
   Pass `$READ_AT` from step 2 — the instant you *read* the code, not the
   instant you got around to writing. This clears the suspect mark *and* stamps
   that instant, which is what makes the repair stick: §24.2.3's verdict is recomputed from git on
   every read, so without the stamp the same commit would re-raise the same flag
   on the next query. Commits made *after* your check will flag it again — that
   is intended.

8. **Supersede — the memory is wrong.**

   Write the correction to a JSON file (prose does not survive a shell
   argument), then record it:

   ```jsonc
   // /tmp/correction.json
   {
     "supersedes": "<the stale memory's id>",
     "task": "<same subject as the old memory — this is what retrieval matches on>",
     "observation": "<the corrected understanding, in full prose>",
     "result": "<optional: what the old memory got wrong and what changed it>",
     "lessons": ["..."],
     "confidence": 0.8
   }
   ```
   ```bash
   node scripts/self-memory.mjs supersede /tmp/correction.json
   ```

   Rules for the correction, all of them load-bearing:
   - **It must stand alone.** It is what retrieval returns from now on; the old
     text is out of the default path. "The above is no longer true" is useless
     to a reader who will never see the above.
   - **Say what changed and why**, not just the new state. The whole measured
     value of this graph (`WHY_MEMORY_SPIKE.md`: 7.7 → 1.4 turns) is *why*
     knowledge, which is exactly what a diff cannot reconstruct.
   - **Synthesized understanding, not a file listing** — spec.md §24.2.1's
     guardrail applies here too. Grep already answers "where is X".
   - **Omit `anchors` unless they genuinely changed.** They are inherited from
     the memory being corrected, which is almost always right.
   - Cite the commit(s) that made the old memory wrong, by short sha.

   The correction and the link are written in one transaction, so a partial
   failure cannot leave two competing answers.

9. **Check your work.** Re-ask the question the memory answers:
   ```bash
   node scripts/self-memory.mjs ask "<the question this memory answers>"
   ```
   The head of the chain — and only the head — should come back.
   `node scripts/self-memory.mjs history <old-id>` shows the full chain if you
   want to see the before/after side by side.

   The correction is normally unflagged, but do not read a flag on it as the
   repair having failed: it is dated now, so any commit landing between the
   supersede and this re-`ask` legitimately flags it, same as any other memory.

10. **Report** what you settled: the memory id, which of the three outcomes, and
   the evidence you based it on (the commit you read, the code you checked).
   If this ran as part of a milestone or dogfood run, that report is the
   evidence — paste the before/after, not a summary of it.

## Things that will bite you

- **`ask` is not `show`.** `ask` truncates observations to 14 lines. Judge a
  memory from `show`, which prints it whole.
- **A superseded memory is not deleted.** `history <id>` still returns it. If
  you find yourself wanting to delete, you want to supersede.
- **You cannot re-point an already-superseded memory.** Chains do not fork —
  supersede the *head* (`show` prints the chain). The command refuses rather
  than orphaning the earlier correction.
- **Confidence is not evidence.** If the only reason you believe the memory is
  wrong is that a file it mentions changed, you have not checked it yet.
