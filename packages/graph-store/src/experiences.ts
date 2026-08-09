import type { Experience } from "@cognitive-memory/core";
import { getPool, type Queryable } from "./db.js";

interface ExperienceRow {
  id: string;
  task: string;
  observation: string;
  hypothesis: string | null;
  action: string | null;
  result: string | null;
  lessons: string[];
  related_nodes: string[];
  confidence: number;
  timestamp: Date;
  cold: boolean;
}

function rowToExperience(row: ExperienceRow): Experience {
  return {
    id: row.id,
    task: row.task,
    observation: row.observation,
    hypothesis: row.hypothesis ?? undefined,
    action: row.action ?? undefined,
    result: row.result ?? undefined,
    lessons: row.lessons,
    relatedNodes: row.related_nodes,
    confidence: row.confidence,
    timestamp: row.timestamp.toISOString(),
  };
}

const EXPERIENCE_COLUMNS = `id, task, observation, hypothesis, action, result, lessons, related_nodes, confidence, "timestamp", cold`;

/**
 * Append-only per spec.md §8 — there is deliberately no update/delete
 * export in this module. If you need to "correct" an experience, record a
 * new one; the promotion pipeline (M3) reasons over the full history.
 */
export async function recordExperience(experience: Experience, db: Queryable = getPool()): Promise<Experience> {
  const { rows } = await db.query<ExperienceRow>(
    `
    INSERT INTO experiences (id, task, observation, hypothesis, action, result, lessons, related_nodes, confidence)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING ${EXPERIENCE_COLUMNS}
    `,
    [
      experience.id,
      experience.task,
      experience.observation,
      experience.hypothesis ?? null,
      experience.action ?? null,
      experience.result ?? null,
      JSON.stringify(experience.lessons ?? []),
      JSON.stringify(experience.relatedNodes),
      experience.confidence,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error(`recordExperience: no row returned for ${experience.id}`);
  return rowToExperience(row);
}

export interface ExperienceQueryOptions {
  /** spec.md §18: cold experiences are excluded from default retrieval. Set true to include them (e.g. an explicit "search full history" request). */
  includeCold?: boolean;
}

export async function queryExperiencesByNode(
  nodeId: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  const pool = getPool();
  const { rows } = await pool.query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
     WHERE related_nodes @> $1::jsonb AND ($2 OR NOT cold)
     ORDER BY "timestamp" DESC`,
    [JSON.stringify([nodeId]), options.includeCold ?? false]
  );
  return rows.map(rowToExperience);
}

export async function queryExperiencesByTask(
  task: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  const pool = getPool();
  const { rows } = await pool.query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
     WHERE task = $1 AND ($2 OR NOT cold)
     ORDER BY "timestamp" DESC`,
    [task, options.includeCold ?? false]
  );
  return rows.map(rowToExperience);
}

/**
 * spec.md §18: mark an experience cold once its lessons have been promoted
 * to a durable semantic edge — still queryable via `includeCold`, just out
 * of the default hot path. Pure status flip, no event: unlike
 * `RelationInvalidated`, cold/hot is not part of the spec.md §14 event
 * vocabulary, and nothing about the experience's own content changed.
 */
export async function markExperienceCold(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE experiences SET cold = true WHERE id = $1`, [id]);
}

/** id + relatedNodes only, for packages/gc's cold-eligibility scan — avoids hydrating full experience rows just to inspect one field. */
export async function listWarmExperienceRefs(): Promise<
  Array<{ id: string; relatedNodes: string[] }>
> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; related_nodes: string[] }>(
    `SELECT id, related_nodes FROM experiences WHERE NOT cold`
  );
  return rows.map((row) => ({ id: row.id, relatedNodes: row.related_nodes }));
}
