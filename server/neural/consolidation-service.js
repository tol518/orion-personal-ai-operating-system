export function stronglyConnectedGroups(nodes, edges, { minimumWeight = 0.72, minimumSize = 3 } = {}) {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    if (edge.archived || edge.weight < minimumWeight) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const visited = new Set();
  const groups = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const group = [];
    visited.add(node.id);
    while (stack.length) {
      const current = stack.pop();
      group.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    if (group.length >= minimumSize) groups.push(group.sort());
  }
  return groups;
}

function parseObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(source.trim());
}

function isConsolidationMemory(memory) {
  const tags = new Set((memory.tags ?? []).map((tag) => String(tag).toLowerCase()));
  return tags.has("consolidation") || Array.isArray(memory.consolidationMembers);
}

export class ConsolidationService {
  constructor({ runner }) {
    this.runner = runner;
  }

  findGroups(memories, edges) {
    // Generated summaries explain a base cluster; including them again creates an endless
    // summary-of-summaries loop after the user approves a consolidation proposal.
    const baseMemories = memories.filter((memory) => !isConsolidationMemory(memory));
    const baseIds = new Set(baseMemories.map((memory) => memory.id));
    const baseEdges = edges.filter(
      (edge) => baseIds.has(edge.source) && baseIds.has(edge.target),
    );
    return stronglyConnectedGroups(baseMemories, baseEdges);
  }

  async summarize(memories) {
    const response = await this.runner.run(
      `Create one higher-level semantic summary memory for this strongly connected group.\n` +
      `Return only JSON: {"title":"under 120 chars","body":"concise Markdown","tags":["summary",...]}.\n` +
      `Do not invent facts.\n\n${JSON.stringify(memories.map((memory) => ({
        id: memory.id,
        title: memory.title,
        body: memory.body.slice(0, 5_000),
        tags: memory.tags,
      })))}`,
    );
    const parsed = parseObject(response);
    const title = String(parsed?.title ?? "").trim().slice(0, 120);
    const body = String(parsed?.body ?? "").trim().slice(0, 10_000);
    if (!title || !body) throw new Error("GPT-5.6 Luna returned an invalid consolidation summary");
    return {
      title,
      body,
      tags: [...new Set(["summary", "consolidation", ...(Array.isArray(parsed.tags) ? parsed.tags.map(String) : [])])].slice(0, 20),
      links: memories.map((memory) => memory.id),
      consolidationMembers: memories.map((memory) => memory.id),
    };
  }
}
