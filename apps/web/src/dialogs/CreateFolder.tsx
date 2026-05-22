import { FolderPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type StoragePolicy } from "../api.js";
import { Dialog } from "../components/Dialog.js";

export function CreateFolderDialog({
  parentId,
  onCreated,
  onError,
  onClose
}: {
  parentId: string | null;
  onCreated: (name: string) => Promise<void> | void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [defaultPolicy, setDefaultPolicy] = useState<StoragePolicy>("standard");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api("/folders", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), parentId, defaultPolicy })
      });
      await onCreated(name.trim());
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="新建文件夹"
      icon={<FolderPlus size={16} style={{ color: "var(--brand)", marginRight: 8 }} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" form="create-folder-form" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy && <span className="spinner" />}
            {busy ? "创建中" : "创建"}
          </button>
        </>
      }
    >
      <form id="create-folder-form" onSubmit={submit} className="stack">
        <div className="field">
          <label className="field-label" htmlFor="folder-name">文件夹名称</label>
          <input
            id="folder-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如:旅行照片"
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="folder-policy">默认策略</label>
          <select
            id="folder-policy"
            className="select"
            value={defaultPolicy}
            onChange={(event) => setDefaultPolicy(event.target.value as StoragePolicy)}
          >
            <option value="standard">普通 · 单副本</option>
            <option value="important">重要 · 至少双副本</option>
            <option value="temporary">临时 · 到期清理</option>
          </select>
          <p className="field-hint">里面新建的文件会继承此策略,也可以单独覆盖。</p>
        </div>
      </form>
    </Dialog>
  );
}
