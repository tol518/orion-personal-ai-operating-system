import { useId, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

export function ChatSheet({
  dialogRef,
  title,
  children,
}: {
  dialogRef: RefObject<HTMLDialogElement>;
  title: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="orion-chat-sheet"
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="orion-chat-sheet-panel">
        <header className="orion-chat-sheet-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            autoFocus
            type="button"
            className="orion-chat-icon-button"
            aria-label={"Close " + title.toLowerCase()}
            onClick={() => dialogRef.current?.close()}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
