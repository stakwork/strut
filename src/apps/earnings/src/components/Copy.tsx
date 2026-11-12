import { useState } from "react";
import { Button } from "@/components/ui/button";

/** An invoice to copy: shown whole, selectable, with Copy (the clipboard API
 *  is every app's; where a host's frame refuses it, select and copy by hand). */
export function CopyText(props: { text: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="flex w-full flex-col gap-2">
      <textarea readOnly className="h-20 w-full resize-none rounded-md border bg-muted p-2 font-mono text-xs break-all" value={props.text} onFocus={(e) => e.currentTarget.select()} />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard?.writeText(props.text).then(
              () => setCopied("Copied."),
              () => setCopied("Select it and copy by hand."),
            )
          }
        >
          Copy invoice
        </Button>
        {copied && <span className="text-xs text-muted-foreground">{copied}</span>}
      </div>
    </div>
  );
}
