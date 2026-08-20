import type { AgentContext } from "./types.js";

function section(title: string, lines: string[]): string {
  const body = lines.length > 0 ? lines.join("\n") : "_None found in this subgraph._";
  return `## ${title}\n\n${body}`;
}

/** AgentContext -> the Markdown text actually handed to the agent. Deterministic given a fixed AgentContext — this is the "compact-context snapshot" ROADMAP M6's acceptance test checks. */
export function renderContext(context: AgentContext): string {
  const sections = [
    section(
      "Relevant Subsystem",
      context.subsystems.map((s) => (s.summary ? `- **${s.name}**: ${s.summary}` : `- **${s.name}**`))
    ),
    section(
      "Relationships",
      context.relationships.map(
        (r) =>
          `- ${r.from.name} --[${r.relation}]--> ${r.to.name} (confidence ${r.confidence.toFixed(2)}, weight ${r.weight.toFixed(2)})`
      )
    ),
    section(
      "Invariants",
      context.invariants.map((i) => (i.summary ? `- **${i.name}**: ${i.summary}` : `- **${i.name}**`))
    ),
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
    section(
      "Source Files",
      context.sourceFiles.map((f) => (f.summary ? `- ${f.path}: ${f.summary}` : `- ${f.path}`))
    ),
  ];

  return [`# Context: ${context.task}`, ...sections].join("\n\n");
}
