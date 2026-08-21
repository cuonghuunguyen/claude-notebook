import type { AgentContext } from "./types.js";

function section(title: string, lines: string[]): string {
  const body = lines.length > 0 ? lines.join("\n") : "_No prior knowledge recorded for this task._";
  return `## ${title}\n\n${body}`;
}

/**
 * AgentContext -> the Markdown text actually handed to the agent.
 * Deterministic given a fixed AgentContext — this is the "compact-context
 * snapshot" ROADMAP M6's acceptance test checks.
 *
 * One section since M15, where §17 originally specified five. The other four
 * described code — subsystems, relationships, invariants, source files — and
 * were projections of the structural graph that M15 removed. Nothing replaced
 * them because nothing needed to: the agent reading this already has the
 * working tree, and the measurement behind §24 is precisely that re-describing
 * the code to it loses to letting it grep (`E2E_BENCHMARK_MULTI_REPO.md`).
 */
export function renderContext(context: AgentContext): string {
  const sections = [
    section(
      "Prior Experience",
      context.experiences.map((e) => {
        const headline = e.result ?? "(no recorded outcome)";
        const lessonLines = e.lessons.map((lesson) => `  - ${lesson}`);
        // The flag goes on the headline, not in a trailing note: an agent
        // skimming this section reads the first line of each entry, and a
        // warning it might skip is a warning that does not work (spec.md
        // §24.2.3). The reason follows in parentheses so "verify" is actionable
        // — it names the commit to look at.
        const flag = e.staleness
          ? ` — **${e.staleness}**${e.stalenessReason ? ` (${e.stalenessReason})` : ""}`
          : "";
        return [`- [${e.task}] ${headline}${flag}`, ...lessonLines].join("\n");
      })
    ),
  ];

  return [`# Context: ${context.task}`, ...sections].join("\n\n");
}
