/**
 * Timestamp normalization for the TEXT columns spec.md §25.5 chose.
 *
 * Postgres stored `timestamptz` and normalized every input to UTC on the way
 * in, whatever offset the caller wrote. SQLite stores text exactly as given, so
 * that normalization has to move here — and it is not cosmetic. `packages/capture`
 * stamps a mined memory with git's `%aI`, which is offset form
 * (`2024-05-01T12:34:56+02:00`), while everything else in the system writes
 * `new Date().toISOString()` (`...Z`). Mixing the two in one column breaks
 * `ORDER BY "timestamp"` and every `>` comparison the §24.2.3 staleness test
 * makes, silently and only for the rows that came from git.
 *
 * A fixed-width UTC ISO string sorts lexicographically in exactly timestamp
 * order, which is what makes TEXT a real choice here rather than a compromise.
 */

/** ISO-8601 UTC with milliseconds, or null. Throws on an unparseable string. */
export function toIsoUtc(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`not a timestamp: ${JSON.stringify(value)}`);
  }
  return date.toISOString();
}

/** Same, for the columns that are NOT NULL. */
export function requireIsoUtc(value: string | Date): string {
  return toIsoUtc(value) as string;
}
