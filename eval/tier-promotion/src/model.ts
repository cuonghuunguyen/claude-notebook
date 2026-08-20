/**
 * The traffic model the §24.5 measurement replays.
 *
 * Deliberately deterministic: a seeded LCG rather than `Math.random`, so the
 * numbers quoted in `spec.md` §24.5 and in M16's merge message are the numbers
 * a reviewer re-running this gets. An eval whose result moves between runs
 * cannot justify a threshold.
 *
 * ## Why the outcome signal here is deliberately NOISY
 *
 * The first version of this model made the task outcome a perfect oracle for
 * memory correctness — misleading memories always caused a failure, sound ones
 * never did. Under that assumption "outcome-gated promotion admits no wrong
 * memory" is arithmetic, not a measurement, and any threshold it justifies is
 * justified by the assumption rather than by the data.
 *
 * The real signal is the quality gate's typecheck+lint+test verdict for a
 * whole task. It is correlated with memory correctness, not equal to it, and it
 * is noisy in BOTH directions:
 *
 *   false confirm — a wrong memory is relied on and the task still passes
 *                   (the tests did not cover what the memory got wrong). This
 *                   is the dangerous direction: it is how a wrong memory earns
 *                   credit, and it is the direction the original model omitted.
 *   false reject  — a task fails for reasons unrelated to anything it
 *                   retrieved, withholding credit from sound memories. Merely
 *                   slows promotion; costs correctness nothing.
 *
 * Both are modelled below. The consequence is that the shipped arm does NOT
 * score a perfect 1.000, and it should not: the honest claim M16 can make is
 * that gating cuts wrong promotions by a measured factor, not that it
 * eliminates them.
 */

/** Numerical Recipes LCG — small, seeded, and good enough to shape a workload. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface SessionEvent {
  sessionId: string;
  /** Everything the session retrieved — the set a broad rule would credit. */
  retrieved: string[];
  /**
   * The memories the session actually relied on, i.e. what a caller would
   * report as `usedExperienceIds`. A subset of `retrieved`.
   */
  reliedOn: string[];
  /** How the retrieving session's TASK ended, per the quality gate. */
  outcome: "confirmed" | "rejected";
}

export interface TrafficModel {
  events: SessionEvent[];
  /**
   * Ground truth for the precision metric: memories that are plausible but
   * WRONG. Retrieval likes them — they match the query — but relying on one
   * makes a task more likely to fail. This is the population §24.5's open
   * problem is about, and the only thing no access counter can see.
   */
  misleadingIds: Set<string>;
  /** Memories that got at least one retrieval at all. */
  retrievedIds: Set<string>;
}

export interface TrafficOptions {
  misleadingShare?: number;
  /** Mean sessions that RELY on a memory that gets used at all. */
  meanSessions?: number;
  /** Share of the corpus nobody ever retrieves (the cold tail §18 GCs). */
  coldShare?: number;
  /** Extra memories returned alongside the one actually relied on. */
  bystandersPerSession?: number;
  /**
   * P(task fails | a misleading memory was relied on). Below 1 because tests
   * do not catch everything — this is the false-confirm channel.
   */
  failGivenMisleading?: number;
  /** P(task fails | nothing misleading was relied on) — the false-reject channel. */
  baseFailRate?: number;
  seed?: number;
}

const DEFAULTS = {
  misleadingShare: 0.125,
  meanSessions: 3,
  coldShare: 0.45,
  bystandersPerSession: 4,
  // A wrong memory slips past the gate about 30% of the time it is relied on.
  // Chosen as a deliberately UNFAVOURABLE assumption for the shipped design:
  // the closer this is to 1, the better outcome-gating looks, so a middling
  // value is the conservative choice rather than a flattering one.
  failGivenMisleading: 0.7,
  baseFailRate: 0.1,
  seed: 20260819,
};

/**
 * Builds a retrieval workload over a corpus.
 *
 * Each session relies on one focal memory and also retrieves a handful of
 * bystanders it does not rely on — which is the realistic shape, and the shape
 * that makes the difference between crediting "everything retrieved by a green
 * task" and "what a green task says it used" measurable at all. A model where
 * every session retrieves exactly what it uses cannot distinguish those two
 * rules, which is why the first version of this file could not either.
 */
export function buildTraffic(experienceIds: string[], options: TrafficOptions = {}): TrafficModel {
  const cfg = { ...DEFAULTS, ...options };
  const random = seededRandom(cfg.seed);

  const misleadingIds = new Set<string>();
  const retrievedIds = new Set<string>();
  const events: SessionEvent[] = [];
  let sessionCounter = 0;

  for (const id of experienceIds) {
    if (random() < cfg.misleadingShare) misleadingIds.add(id);
  }

  for (const id of experienceIds) {
    if (random() < cfg.coldShare) continue; // never relied on
    retrievedIds.add(id);

    let sessions = 1;
    while (random() > 1 / cfg.meanSessions && sessions < 12) sessions++;

    for (let i = 0; i < sessions; i++) {
      // Bystanders: retrieved alongside the focal memory, not relied on.
      const bystanders: string[] = [];
      for (let b = 0; b < cfg.bystandersPerSession; b++) {
        const pick = experienceIds[Math.floor(random() * experienceIds.length)];
        if (pick && pick !== id) {
          bystanders.push(pick);
          retrievedIds.add(pick);
        }
      }

      const reliedOnMisleading = misleadingIds.has(id);
      const failProbability = reliedOnMisleading ? cfg.failGivenMisleading : cfg.baseFailRate;
      const failed = random() < failProbability;

      events.push({
        sessionId: `replay-session-${sessionCounter++}`,
        retrieved: [id, ...bystanders],
        reliedOn: [id],
        outcome: failed ? "rejected" : "confirmed",
      });
    }
  }

  return { events, misleadingIds, retrievedIds };
}
