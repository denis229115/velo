import { useState } from "react";
import { X, FolderPlus } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { useThreadStore } from "@/stores/threadStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { InputDialog } from "@/components/ui/InputDialog";

const iconButton =
  "w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors";

/** List header buttons to save or clear the search shown; the search icon lives in the sidebar header. */
export function ListSearchActions() {
  const searchQuery = useThreadStore((s) => s.searchQuery);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const query = searchQuery.trim();

  return (
    <>
      {query && (
        <>
          <button
            type="button"
            onClick={() => setShowSaveModal(true)}
            aria-label="Save as Smart Folder"
            title="Save as Smart Folder"
            className={iconButton}
          >
            <FolderPlus size={15} />
          </button>
          <button
            type="button"
            onClick={() => useThreadStore.getState().clearSearch()}
            aria-label="Clear search"
            title="Clear search"
            className={iconButton}
          >
            <X size={15} />
          </button>
        </>
      )}
      <InputDialog
        isOpen={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSubmit={(values) => {
          useSmartFolderStore.getState().createFolder(values.name!.trim(), query, activeAccountId ?? undefined);
        }}
        title="Save as Smart Folder"
        fields={[{ key: "name", label: "Name", defaultValue: query }]}
        submitLabel="Save"
      />
    </>
  );
}
