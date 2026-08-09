import type { Experience } from "@cognitive-memory/core";
import { getPool } from "./db.js";

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

const EXPERIENCE_COLUMNS = `id, task, observation, hypothesis, action, result, lessons, related_nodes, confidence, "timestamp"`;

/**
 * Append-only per spec.md §8 — there is deliberately no update/delete
 * export in this module. If you need to "correct" an experience, record a
 * new one; the promotion pipeline (M3) reasons over the full history.
 */
export async function recordExperience(experience: Experience): Promise<Experience> {
  const pool = getPool();
  const { rows } = await pool.query<ExperienceRow>(
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

export async function queryExperiencesByNode(nodeId: string): Promise<Experience[]> {
  const pool = getPool();
  const { rows } = await pool.query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences WHERE related_nodes @> $1::jsonb ORDER BY "timestamp" DESC`,
    [JSON.stringify([nodeId])]
  );
  return rows.map(rowToExperience);
}
