import { memo, useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { Thread } from "@/stores/threadStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { Archive, BellRing, Mail, MailOpen, Pin, Trash2, VolumeX } from "lucide-react";
import { ListRow, type ListRowAction } from "@/components/list/ListRow";
import { archiveThread, markThreadRead, starThread, trashThread } from "@/services/emailActions";
import type { DragData } from "@/components/dnd/DndProvider";

const CATEGORY_COLORS: Record<string, string> = {
  Updates: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  Promotions: "bg-green-500/15 text-green-600 dark:text-green-400",
  Social: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  Newsletters: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
};

interface ThreadCardProps {
  thread: Thread;
  isSelected: boolean;
  onClick: (thread: Thread) => void;
  onContextMenu?: (e: React.MouseEvent, threadId: string) => void;
  category?: string;
  showCategoryBadge?: boolean;
  hasFollowUp?: boolean;
}

export const ThreadCard = memo(function ThreadCard({ thread, isSelected, onClick, onContextMenu, category, showCategoryBadge, hasFollowUp }: ThreadCardProps) {
  const isMultiSelected = useThreadStore((s) => s.selectedThreadIds.has(thread.id));
  const hasMultiSelect = useThreadStore((s) => s.selectedThreadIds.size > 0);
  const toggleThreadSelection = useThreadStore((s) => s.toggleThreadSelection);
  const selectThreadRange = useThreadStore((s) => s.selectThreadRange);
  const activeLabel = useActiveLabel();
  const emailDensity = useUIStore((s) => s.emailDensity);
  const isSpam = thread.labelIds.includes("SPAM");

  // Read selectedThreadIds lazily for drag — avoids subscribing all cards to the Set reference
  const dragData: DragData = useMemo(() => ({
    threadIds: hasMultiSelect && isMultiSelected
      ? [...useThreadStore.getState().selectedThreadIds]
      : [thread.id],
    sourceLabel: activeLabel,
  }), [hasMultiSelect, isMultiSelected, thread.id, activeLabel]);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `thread-${thread.id}`,
    data: dragData,
  });

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      selectThreadRange(thread.id);
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleThreadSelection(thread.id);
    } else if (hasMultiSelect) {
      toggleThreadSelection(thread.id);
    } else {
      onClick(thread);
    }
  };

  const handleContextMenu = onContextMenu
    ? (e: React.MouseEvent) => onContextMenu(e, thread.id)
    : undefined;

  const { accountId, id } = thread;
  const quickActions: ListRowAction[] = [
    { label: "Archive", icon: Archive, onAction: () => void archiveThread(accountId, id, []) },
    ...(activeLabel === "trash"
      ? []
      : [{ label: "Move to trash", icon: Trash2, onAction: () => void trashThread(accountId, id, []) }]),
    {
      label: thread.isRead ? "Mark as unread" : "Mark as read",
      icon: thread.isRead ? Mail : MailOpen,
      onAction: () => void markThreadRead(accountId, id, [], !thread.isRead),
    },
  ];

  const indicators = (
    <>
      {showCategoryBadge && category && category !== "Primary" && CATEGORY_COLORS[category] && (
        // Narrow list (reading pane open): hidden so the sender name keeps the space
        <span className={`hidden @2xl:inline shrink-0 text-micro px-1.5 rounded-full leading-normal ${CATEGORY_COLORS[category]}`}>
          {category}
        </span>
      )}
      {hasFollowUp && (
        <span className="shrink-0 text-accent" title="Follow-up reminder set">
          <BellRing size={12} />
        </span>
      )}
      {thread.isMuted && (
        <span className="shrink-0 text-warning" title="Muted">
          <VolumeX size={12} />
        </span>
      )}
      {thread.isPinned && (
        <span className="shrink-0 text-accent" title="Pinned">
          <Pin size={12} className="fill-current" />
        </span>
      )}
      {thread.messageCount > 1 && (
        <span className="text-micro tabular-nums text-text-tertiary shrink-0 bg-bg-tertiary rounded-full px-1.5">
          {thread.messageCount}
        </span>
      )}
    </>
  );

  return (
    <ListRow
      density={emailDensity}
      unread={!thread.isRead}
      sender={thread.fromName ?? thread.fromAddress ?? "Unknown"}
      subject={thread.subject ?? "(No subject)"}
      preview={thread.snippet}
      time={thread.lastMessageAt}
      hasAttachment={thread.hasAttachments}
      selected={isSelected}
      checked={isMultiSelected}
      starred={thread.isStarred}
      onToggleStar={() => void starThread(accountId, id, [], !thread.isStarred)}
      actions={quickActions}
      indicators={indicators}
      onClick={handleClick}
      buttonRef={setNodeRef}
      buttonProps={{
        ...attributes,
        ...listeners,
        onContextMenu: handleContextMenu,
        "aria-label": `${thread.isRead ? "" : "Unread "}email from ${thread.fromName ?? thread.fromAddress ?? "Unknown"}: ${thread.subject ?? "(No subject)"}`,
      }}
      className={`${isDragging ? "opacity-50" : ""} ${isSpam ? "bg-red-500/8 dark:bg-red-500/10" : ""}`}
    />
  );
});
