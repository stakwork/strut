// @mermaid-js/tiny ships no types: the part MermaidDiagram calls. The kit
// freezes its classic script as a CommonJS module whose export is Mermaid
// (kit/scripts/manifest.ts, SCRIPT_EXPORTS).
declare module "@mermaid-js/tiny" {
  const mermaid: {
    initialize(config: object): void;
    render(id: string, text: string): Promise<{ svg: string }>;
  };
  export default mermaid;
}
