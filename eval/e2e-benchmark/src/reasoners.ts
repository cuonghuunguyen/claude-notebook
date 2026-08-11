/**
 * The two ReasoningProviders the benchmark runs traversal with:
 *
 * - heuristic: expand any candidate whose §11 score clears a floor. Fast,
 *   deterministic, zero LLM cost — the "no reasoning model available"
 *   configuration.
 * - claude: a real LLM reasoner over the `claude` CLI (headless `-p` mode),
 *   one call per depth level exactly as spec.md §10 intends. This is the
 *   configuration the system was actually designed for.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getNodesByIds } from "@cognitive-memory/graph-store";
import type {
  ReasoningContext,
  ReasoningProvider,
  ReasoningResult,
} from "@cognitive-memory/traversal";

const execFileAsync = promisify(execFile);

export function createHeuristicReasoner(minScore = 0.15): ReasoningProvider {
  return {
    async decide(context: ReasoningContext): Promise<ReasoningResult> {
      return {
        decisions: context.candidates.map((c) => ({
          edgeId: c.edgeId,
          action: c.score >= minScore ? "expand" : "skip",
        })),
        stop: false,
      };
    },
  };
}

export interface ClaudeReasonerStats {
  calls: number;
  totalLatencyMs: number;
  parseFailures: number;
}

export function createClaudeReasoner(
  model = "claude-haiku-4-5-20251001",
  stats: ClaudeReasonerStats = { calls: 0, totalLatencyMs: 0, parseFailures: 0 }
): ReasoningProvider & { stats: ClaudeReasonerStats } {
  const fallback = createHeuristicReasoner();
  return {
    stats,
    async decide(context: ReasoningContext): Promise<ReasoningResult> {
      const nodes = await getNodesByIds(context.candidates.map((c) => c.neighborNodeId));
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const lines = context.candidates.map((c) => {
        const n = nodeById.get(c.neighborNodeId);
        const label = n ? `${n.type} ${n.name ?? ""} (${n.path ?? "no path"})` : "unknown node";
        return `- edgeId=${c.edgeId} relation=${c.relation} score=${c.score.toFixed(3)} -> ${label}`;
      });
      const prompt = [
        `You are the traversal reasoner of a code-graph memory system.`,
        `Task the agent is working on: "${context.task}"`,
        `Depth level ${context.depth}. Frontier candidates (already ranked):`,
        ...lines,
        ``,
        `For each candidate decide "expand" (likely relevant to the task) or "skip".`,
        `Set "stop": true only if the visited graph is clearly already sufficient.`,
        `Reply with ONLY this JSON, no prose:`,
        `{"decisions":[{"edgeId":"...","action":"expand|skip"}],"stop":false}`,
      ].join("\n");

      const t0 = Date.now();
      stats.calls += 1;
      try {
        const { stdout } = await execFileAsync(
          "claude",
          ["-p", prompt, "--model", model],
          { timeout: 120_000, cwd: process.env["BENCH_CLAUDE_CWD"] ?? process.cwd() }
        );
        stats.totalLatencyMs += Date.now() - t0;
        const match = stdout.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("no JSON in reasoner output");
        const parsed = JSON.parse(match[0]) as ReasoningResult;
        const byEdge = new Map(parsed.decisions.map((d) => [d.edgeId, d.action]));
        // Guarantee exactly one decision per candidate regardless of what the
        // model returned; unknown/missing edges fall back to "skip".
        return {
          decisions: context.candidates.map((c) => ({
            edgeId: c.edgeId,
            action: byEdge.get(c.edgeId) === "expand" ? "expand" : "skip",
          })),
          stop: parsed.stop === true,
        };
      } catch (err) {
        stats.totalLatencyMs += Date.now() - t0;
        stats.parseFailures += 1;
        console.error(`claude reasoner failed (${(err as Error).message}); heuristic fallback`);
        return fallback.decide(context);
      }
    },
  };
}
