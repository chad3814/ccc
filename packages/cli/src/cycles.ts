const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export function findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const node of [...edges.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      visit(node);
    }
  }
  return cycles;
}
