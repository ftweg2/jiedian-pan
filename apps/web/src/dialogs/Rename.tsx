import { Edit3 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type FileItem, type FolderItem } from "../api.js";
import { Dialog } from "../components/Dialog.js";

export type RenameTarget =
  | { kind: "file"; file: FileItem }
  | { kind: "folder"; folder: FolderItem };

export function RenameDialog({
  target,
  onClose,
  onRenamed,
  onError
}: {
  target: RenameTarget;
  onClose: () => void;
  onRenamed: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const initial = target.kind === "file" ? target.file.name : target.folder.name;
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === initial) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      if (target.kind === "file") {
        await api(`/files/${target.file.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: trimmed })
        });
      } else {
        await api(`/folders/${target.folder.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: trimmed })
        });
      }
      await onRenamed();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "重命名失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={target.kind === "folder" ? "重命名文件夹" : "重命名文件"}
      icon={<Edit3 size={16} style={{ color: "var(--brand)", marginRight: 8 }} />}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" form="rename-form" className="btn btn-primary" disabled={busy || !name.trim() || name.trim() === initial}>
            {busy && <span className="spinner" />}
            {busy ? "保存中" : "保存"}
          </button>
        </>
      }
    >
      <form id="rename-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="rename-input">新名称</label>
          <input
            id="rename-input"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            onFocus={(event) => {
              // 选中文件名主体,但保留扩展名(对文件)
              const v = event.target.value;
              if (target.kind === "file") {
                const dot = v.lastIndexOf(".");
                if (dot > 0) event.target.setSelectionRange(0, dot);
                else event.target.select();
              } else {
                event.target.select();
              }
            }}
          />
        </div>
      </form>
    </Dialog>
  );
}
