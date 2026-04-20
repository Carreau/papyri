import type { IRNode, TypedNode } from "./ir-reader.ts";

export interface NodeConfig {
  label: string;
  types: ReadonlySet<string>;
  displayValue(n: IRNode): string | null;
}

export const NODE_CONFIGS: Record<string, NodeConfig> = {
  math: {
    label: "Math",
    types: new Set(["Math", "InlineMath"]),
    displayValue(n) {
      const v = (n as TypedNode).value;
      return typeof v === "string" ? v : null;
    },
  },
  code: {
    label: "Code",
    types: new Set(["Code", "InlineCode"]),
    displayValue(n) {
      const v = (n as TypedNode).value;
      return typeof v === "string" ? v : null;
    },
  },
};
