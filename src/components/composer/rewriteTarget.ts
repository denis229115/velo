import type { Editor } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/** Keep a proposal attached to its original text while other parts of the draft change. */
export function captureRewriteTarget(editor: Editor, selectionOnly: boolean) {
  let { from, to } = selectionOnly ? editor.state.selection : { from: 0, to: editor.state.doc.content.size };
  const original = editor.state.doc.slice(from, to);
  const container = document.createElement("div");
  container.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(original.content));
  let valid = true;
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged || !valid) return;
    from = transaction.mapping.map(from, 1);
    to = transaction.mapping.map(to, -1);
    valid = from <= to && transaction.doc.slice(from, to).eq(original);
  };
  editor.on("transaction", onTransaction);
  return {
    before: container.innerHTML,
    range: () => valid ? { from, to } : null,
    dispose: () => { editor.off("transaction", onTransaction); },
  };
}
