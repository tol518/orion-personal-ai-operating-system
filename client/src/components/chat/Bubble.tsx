import { BrainCircuit, Paperclip } from "lucide-react";
import type { StoredAttachment } from "../../lib/api";
import {
  ALL_HIDDEN_MARKERS,
  type MemoryCitation,
  type LearnedLesson,
  type SavedMemory,
} from "../../lib/chat/messages";
import { Markdown, Copy } from "./Markdown";
import { timeLabel } from "../../lib/chat/workspace";
export function Bubble({
  role,
  text,
  streaming,
  time,
  memoryCitations = [],
  savedMemories = [],
  learnedLessons = [],
  attachments = [],
}: {
  role: "user" | "agent";
  text: string;
  streaming?: boolean;
  time?: number;
  memoryCitations?: MemoryCitation[];
  savedMemories?: SavedMemory[];
  learnedLessons?: LearnedLesson[];
  attachments?: StoredAttachment[];
}) {
  const mine = role === "user";
  const visibleText = text.replace(ALL_HIDDEN_MARKERS, "").trimEnd();
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        data-role={role}
        className={`orion-chat-bubble max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 font-mono text-sm ${
          mine
            ? "border border-hudborder-light bg-accent/10 text-accent-hover"
            : "border border-hudborder bg-surface-2 text-gray-200"
        } ${streaming ? "opacity-90" : ""}`}
      >
        {mine ? visibleText : <Markdown text={visibleText} />}
        <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400">
          {time && (
            <time title={new Date(time).toLocaleString()}>
              {timeLabel(time)}
            </time>
          )}
          <Copy text={visibleText} />
        </div>
        {attachments.length ? (
          <AttachmentList attachments={attachments} />
        ) : null}
        {streaming && (
          <span className="ml-0.5 animate-pulse text-accent">▍</span>
        )}
        {!streaming && memoryCitations.length ? (
          <div className="chat-memory-citations">
            <span>
              <BrainCircuit size={12} /> Memories used
            </span>
            <div>
              {memoryCitations.map((citation) => (
                <a
                  key={citation.id}
                  href={`#memory?id=${encodeURIComponent(citation.id)}`}
                >
                  {citation.title}
                </a>
              ))}
            </div>
          </div>
        ) : null}
        {!streaming && savedMemories.length ? (
          <div className="chat-memory-citations">
            <span>
              <BrainCircuit size={12} /> Memory saved
            </span>
            <div>
              {savedMemories.map((memory) => (
                <a
                  key={memory.id}
                  href={`#memory?id=${encodeURIComponent(memory.id)}`}
                >
                  {memory.title}
                </a>
              ))}
            </div>
          </div>
        ) : null}
        {!streaming && learnedLessons.length ? (
          <div className="chat-memory-citations">
            <span>
              <BrainCircuit size={12} /> Shared brain learned
            </span>
            <div>
              {learnedLessons.map((lesson) =>
                lesson.id ? (
                  <a
                    key={lesson.id}
                    href={`#memory?id=${encodeURIComponent(lesson.id)}`}
                  >
                    {lesson.title}
                  </a>
                ) : (
                  <span key={lesson.title}>{lesson.title}</span>
                ),
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AttachmentList({ attachments }: { attachments: StoredAttachment[] }) {
  return (
    <div className="mt-2 grid gap-2">
      {attachments.map((attachment) =>
        attachment.mimeType.startsWith("image/") ? (
          <a
            key={attachment.id}
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded border border-hudborder"
          >
            <img
              src={attachment.url}
              alt={attachment.fileName}
              className="max-h-64 w-full object-contain"
            />
          </a>
        ) : attachment.mimeType.startsWith("video/") ? (
          <video
            key={attachment.id}
            src={attachment.url}
            controls
            className="max-h-64 w-full rounded border border-hudborder"
          />
        ) : (
          <a
            key={attachment.id}
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded border border-hudborder bg-black/20 px-2 py-1.5 text-xs text-accent-hover"
          >
            <Paperclip size={12} />
            <span className="truncate">{attachment.fileName}</span>
          </a>
        ),
      )}
    </div>
  );
}
