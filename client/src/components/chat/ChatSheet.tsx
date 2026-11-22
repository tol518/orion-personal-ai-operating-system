import { useId, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

export async function closeChatSheet(dialog: HTMLDialogElement | null) {
  if (!dialog?.open || dialog.hasAttribute("data-closing")) return;

  // Keep the native modal in the top layer until its exit animation finishes.
  dialog.setAttribute("data-closing", "");
  const animations = dialog.getAnimations();
  if (animations.length) {
    await Promise.allSettled(animations.map((animation) => animation.finished));
  }
  dialog.close();
  dialog.removeAttribute("data-closing");
}

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
        if (event.target === event.currentTarget) void closeChatSheet(event.currentTarget);
      }}
      onCancel={(event) => {
        event.preventDefault();
        void closeChatSheet(event.currentTarget);
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
            onClick={() => void closeChatSheet(dialogRef.current)}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
