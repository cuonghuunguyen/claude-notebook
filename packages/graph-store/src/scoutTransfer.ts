/**
 * One-shot scout-report export/import (spec.md §25.5 decision 2).
 *
 * There is deliberately no data-migration path from an existing Postgres
 * database, and this file is the single exception the decision carves out.
 *
 * The reasoning is about reproducibility, not effort. Mined memories are
 * derived data: `captureGitHistory` is idempotent and reads the repository's own
 * history in ~240 ms, so a fresh SQLite file can be refilled from git with one
 * command and the result is byte-for-byte the memory the old database held. A
 * *scout report* — the understanding a session worked out and wrote back
 * (`.claude/scout-report.json`, `recordScoutReport`) — has no external source.
 * It exists only in the database it was written to. Nothing can regenerate it,
 * and it is the half `WHY_MEMORY_SPIKE.md` measured as the one that pays.
 *
 * So the port ships a transfer for exactly that class and nothing else. It is a
 * one-shot: run it once against the old database, import once into the new one,
 * and then delete nothing — the export is a plain JSON file, so it stays
 * reviewable and re-importable if the first import is wrong.
 *
 * ## What travels with a report, and why it is more than its text
 *
 * A first cut exported only the §8 fields and wrote them back through
 * `recordExperience`. That loses four pieces of state that no amount of
 * re-mining can rebuild, and the first of them is not a missing detail but a
 * corruption: a report that read-repair had RETRACTED came back as a live chain
 * head, so by-meaning retrieval answered with knowledge the system had
 * withdrawn — the exact fork §24.2 decision 4 exists to prevent, on the one
 * class of memory §25.5 says is irreplaceable. Also lost: `verified_at` (so
 * every imported report is re-flagged by the next staleness pass, undoing a
 * human's read-repair), `writer_session` (which silently disables §24.5's
 * no-self-promotion rule for imported rows), and the `suspect` verdict.
 *
 * So the transfer carries them, and the import restores them in dependency
 * order: every row first, then the links between rows.
 *
 * Scout reports are identified the way capture identifies them: `action` starts
 * with `scout-report`. That is the same key `listExperienceActions` uses for
 * capture's own idempotency check.
 *
 * The prefix is duplicated here rather than imported, because `packages/capture`
 * depends on this package and not the other way round. A duplicated constant
 * that silently drifts would make this export return zero rows and look like
 * "there were no scout reports" — the one failure mode that loses exactly the
 * data this file exists to save — so `packages/capture`'s own test asserts the
 * two are equal.
 */
import type { Experience } from "@cognitive-memory/core";
import { getDb } from "./db.js";
import {
  markExperienceVerified,
  markExperiencesSuspect,
  recordExperience,
  supersedeExperience,
} from "./experiences.js";

/** The `action` prefix `packages/capture`'s `recordScoutReport` writes. */
export const SCOUT_ACTION_PREFIX = "scout-report";

/**
 * State that lives on a memory but is not part of its spec.md §8 content —
 * carried alongside each experience rather than folded into it, because
 * `Experience` is a §8 type and this is storage/repair metadata (the same
 * reason `tier` rides on a search hit instead of on `Experience`).
 */
export interface ScoutTransferState {
  /** §24.6: the instant read-repair last checked this report against the code. */
  verifiedAt?: string;
  /** §24.2.3's persisted verdict, and its reason. */
  suspect?: boolean;
  suspectReason?: string;
  /** §24.5's no-self-promotion key. */
  writerSession?: string;
  /** §24.2 decision 4: the correction that retracted this report, if any. */
  supersededBy?: string;
  supersededAt?: string;
}

export interface ScoutExport {
  /** Bumped only if the shape below changes; an importer refuses what it cannot read. */
  version: 2;
  exportedAt: string;
  experiences: Experience[];
  /** Per-experience repair/accounting state, keyed by experience id. */
  state?: Record<string, ScoutTransferState>;
}

/**
 * Every scout report in the current database, as a portable JSON document.
 *
 * Reads through plain SQL rather than through the search legs so it cannot be
 * affected by §18's cold flag or §24.6's supersede filter: this is an export of
 * *everything*, including a report that has since been corrected, because
 * dropping the retracted text on the way out would lose the history
 * `memoryHistory` exists to answer.
 *
 * Embeddings are NOT exported. They are derived from the text by an injected
 * provider (spec.md §9) and are 6 KB each; a `sync` with an embedder rebuilds
 * them, and `listExperienceIdsMissingEmbedding` is exactly the backfill for the
 * rows this import creates without one.
 */
export async function exportScoutReports(): Promise<ScoutExport> {
  const { rows } = await getDb().query<{
    id: string;
    task: string;
    observation: string;
    hypothesis: string | null;
    action: string | null;
    result: string | null;
    lessons: string;
    related_nodes: string;
    anchors: string;
    confidence: number;
    timestamp: string;
    verified_at: string | null;
    suspect: number;
    suspect_reason: string | null;
    writer_session: string | null;
    superseded_by: string | null;
    superseded_at: string | null;
  }>(
    `SELECT id, task, observation, hypothesis, action, result, lessons,
            related_nodes, anchors, confidence, "timestamp",
            verified_at, suspect, suspect_reason, writer_session,
            superseded_by, superseded_at
       FROM experiences
      WHERE action LIKE $1 || '%'
      ORDER BY "timestamp", id`,
    [SCOUT_ACTION_PREFIX]
  );
  const state: Record<string, ScoutTransferState> = {};
  for (const row of rows) {
    state[row.id] = {
      verifiedAt: row.verified_at ?? undefined,
      suspect: row.suspect === 1,
      suspectReason: row.suspect_reason ?? undefined,
      writerSession: row.writer_session ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
      supersededAt: row.superseded_at ?? undefined,
    };
  }
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    experiences: rows.map((row) => ({
      id: row.id,
      task: row.task,
      observation: row.observation,
      hypothesis: row.hypothesis ?? undefined,
      action: row.action ?? undefined,
      result: row.result ?? undefined,
      lessons: JSON.parse(row.lessons) as string[],
      relatedNodes: JSON.parse(row.related_nodes) as string[],
      anchors: JSON.parse(row.anchors) as Experience["anchors"],
      confidence: row.confidence,
      timestamp: row.timestamp,
    })),
    state,
  };
}

export interface ImportResult {
  imported: number;
  /** Already present with the same id — the import is safe to re-run. */
  skipped: number;
  /** Supersede links restored between imported rows (§24.2 decision 4). */
  relinked: number;
  /**
   * Retractions whose correction is not in this database — a scout report
   * superseded by a MINED memory the export deliberately omits. Non-zero means
   * run `sync`, then `relinkScoutSupersedes`; until then those reports are live
   * heads again, which the caller needs to be told rather than left to discover.
   */
  unlinkable: number;
}

/**
 * Writes an export into the current database.
 *
 * Idempotent by id: a report already present is counted and skipped rather than
 * failing the whole import on a primary-key collision, because the realistic
 * way this gets run twice is "the first run half-finished".
 *
 * No `ExperienceRecorded` event is appended, and that is deliberate. The event
 * log's job (spec.md §14) is to record what the system was *told*, and these
 * memories were already told to the system once — in the database they came
 * from, whose log is not being migrated. Synthesizing fresh events here would
 * claim these reports were authored now, which would put a wrong `occurred_at`
 * on the only record of when a session actually worked something out.
 */
export async function importScoutReports(payload: ScoutExport): Promise<ImportResult> {
  if (payload.version !== 2) {
    throw new Error(
      `unsupported scout export version: ${String(payload.version)} (this build reads 2)`
    );
  }
  const { rows: existing } = await getDb().query<{ id: string }>(
    `SELECT id FROM experiences WHERE id IN (SELECT value FROM json_each($1))`,
    [JSON.stringify(payload.experiences.map((experience) => experience.id))]
  );
  const present = new Set(existing.map((row) => row.id));
  const state = payload.state ?? {};

  // Pass 1: every row, with the state that belongs to the row itself.
  let imported = 0;
  for (const experience of payload.experiences) {
    if (present.has(experience.id)) continue;
    const own = state[experience.id] ?? {};
    await recordExperience(experience, getDb(), { writerSession: own.writerSession });
    if (own.verifiedAt) await markExperienceVerified(experience.id, own.verifiedAt);
    if (own.suspect) {
      await markExperiencesSuspect([
        { id: experience.id, reason: own.suspectReason ?? "imported as suspect" },
      ]);
    }
    imported += 1;
  }

  // Pass 2: the links BETWEEN rows, once every row exists.
  //
  // Two passes rather than one, because `supersedeExperience` refuses a link
  // whose target is missing — and an export ordered by timestamp routinely puts
  // a correction before the memory it retracts, since a correction can carry an
  // older commit date than its predecessor (`listSupersedeChain` documents the
  // same asymmetry).
  let relinked = 0;
  let unlinkable = 0;
  for (const experience of payload.experiences) {
    const own = state[experience.id];
    if (!own?.supersededBy) continue;
    const { rows: target } = await getDb().query<{ id: string }>(
      `SELECT id FROM experiences WHERE id = $1`,
      [own.supersededBy]
    );
    if (!target[0]) {
      // The correction is not in this database. That is a legitimate state, not
      // a corrupt export: a scout report can be retracted in favour of a MINED
      // memory, which the export omits because git regenerates it. Counted and
      // skipped rather than thrown, so one such link cannot abort an import that
      // is otherwise fine — and `relinkScoutSupersedes` is the repair to run
      // once `sync` has brought the correction back.
      unlinkable += 1;
      continue;
    }
    const result = await supersedeExperience(experience.id, own.supersededBy, {
      supersededAt: own.supersededAt,
    });
    if (result.linked) relinked += 1;
  }

  return { imported, skipped: present.size, relinked, unlinkable };
}

/**
 * Restores a supersede link that `importScoutReports` could not, because the
 * correction lives outside the export.
 *
 * A scout report can be retracted in favour of a *mined* memory, which the
 * export deliberately omits (it is reproducible from git). Re-running `sync`
 * before the import therefore makes the link restorable; running it after does
 * not, and this is the repair for that ordering — `ImportResult.unlinkable`
 * reports how many links are waiting for it.
 *
 * Deliberately NOT wrapped in one transaction. Each link is independently valid
 * and `supersedeExperience` owns a transaction per link, so a partial run leaves
 * a consistent database and re-running finishes the job; one shared transaction
 * would mean nesting (which `withTransaction` refuses outright) and would make
 * one missing correction discard every link that did resolve.
 */
export async function relinkScoutSupersedes(payload: ScoutExport): Promise<number> {
  let relinked = 0;
  for (const [id, own] of Object.entries(payload.state ?? {})) {
    if (!own.supersededBy) continue;
    const { rows } = await getDb().query<{ id: string }>(
      `SELECT id FROM experiences WHERE id = $1 AND superseded_by IS NULL`,
      [id]
    );
    if (!rows[0]) continue;
    const { rows: target } = await getDb().query<{ id: string }>(
      `SELECT id FROM experiences WHERE id = $1`,
      [own.supersededBy]
    );
    if (!target[0]) continue;
    const result = await supersedeExperience(id, own.supersededBy, {
      supersededAt: own.supersededAt,
    });
    if (result.linked) relinked += 1;
  }
  return relinked;
}
