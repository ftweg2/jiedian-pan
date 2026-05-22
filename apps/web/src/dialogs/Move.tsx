import { ChevronLeft, ChevronRight, Folder as FolderIcon, FolderOpen, Home, Move } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type FileItem, type FolderItem } from "../api.js";
import { Dialog } from "../components/Dialog.js";
import type { BrowserItem } from "../lib/types.js";

export interface MoveTarget {
  items: BrowserItem[];          // 多选项,可能是文件也可能是文件夹
  currentParentId: string | null; // 当前所在父目录(用于在 picker 里高亮 / 禁用)
}

export function MoveDialog({
  targets,
  onClose,
  onMoved,
  onError
}: {
  targets: MoveTarget;
  onClose: () => void;
  onMoved: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [pickerFolderId, setPickerFolderId] = useState<string | null>(null);
  const [pickerPath, setPickerPath] = useState<FolderItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 当前是否要把所选移动到 root(pickerFolderId === null)
  // 当 picker 处于某个文件夹内时,"选定此处" 把项目移到 pickerFolderId
  const destinationId = pickerFolderId;
  const destinationName = pickerFolderId === null
    ? "全部文件(根目录)"
    : pickerPath[pickerPath.length - 1]?.name ?? "选定的文件夹";

  // 不允许把文件夹移动到自己 / 子目录里:这些 id 不能作为目标
  const forbiddenIds = new Set<string>(
    targets.items
      .filter((item): item is Extract<BrowserItem, { kind: "folder" }> => item.kind === "folder")
      .map((item) => item.folder.id)
  );

  // 检查目标合法性
  const sameAsSource = destinationId === targets.currentParentId;
  const destinationIsAmongMoved = destinationId != null && forbiddenIds.has(destinationId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = pickerFolderId ? `?parentId=${pickerFolderId}` : "";
    api<{ folders: FolderItem[] }>(`/folders${query}`)
      .then((res) => {
        if (cancelled) return;
        setFolders(res.folders.filter((f) => !forbiddenIds.has(f.id)));
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "加载失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerFolderId]);

  function openFolder(folder: FolderItem) {
    setPickerFolderId(folder.id);
    setPickerPath((path) => {
      const existing = path.findIndex((entry) => entry.id === folder.id);
      return existing >= 0 ? path.slice(0, existing + 1) : [...path, folder];
    });
  }

  function jumpTo(index: number) {
    if (index < 0) {
      setPickerFolderId(null);
      setPickerPath([]);
      return;
    }
    const folder = pickerPath[index];
    if (!folder) return;
    setPickerFolderId(folder.id);
    setPickerPath(pickerPath.slice(0, index + 1));
  }

  async function confirmMove() {
    if (sameAsSource || destinationIsAmongMoved) return;
    setBusy(true);
    try {
      for (const item of targets.items) {
        if (item.kind === "folder") {
          await api(`/folders/${item.folder.id}`, {
            method: "PATCH",
            body: JSON.stringify({ parentId: destinationId })
          });
        } else {
          await api(`/files/${item.file.id}`, {
            method: "PATCH",
            body: JSON.stringify({ folderId: destinationId })
          });
        }
      }
      await onMoved();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "移动失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`移动 ${targets.items.length} 项`}
      icon={<Move size={16} style={{ color: "var(--brand)", marginRight: 8 }} />}
      size="lg"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <div style={{ marginRight: "auto", fontSize: 12 }} className="muted">
            目标:<strong style={{ color: "var(--fg)" }}>{destinationName}</strong>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirmMove}
            disabled={busy || sameAsSource || destinationIsAmongMoved}
          >
            {busy && <span className="spinner" />}
            {sameAsSource ? "已在此目录" :
              destinationIsAmongMoved ? "不能移到自己里" :
              busy ? "移动中" :
              `移动到此处`}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ flexWrap: "wrap", gap: 2, fontSize: 13 }}>
          <button
            type="button"
            className={`crumb ${pickerFolderId === null ? "is-current" : ""}`}
            onClick={() => jumpTo(-1)}
          >
            <Home size={12} style={{ verticalAlign: -2, marginRight: 4 }} />全部文件
          </button>
          {pickerPath.map((folder, index) => (
            <span key={folder.id} className="row" style={{ gap: 0 }}>
              <span className="sep"><ChevronRight size={12} /></span>
              <button
                type="button"
                className={`crumb ${index === pickerPath.length - 1 ? "is-current" : ""}`}
                onClick={() => jumpTo(index)}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </div>

        {error && <div className="alert alert-danger">{error}</div>}

        <div className="table-wrap" style={{ maxHeight: 360, overflow: "auto" }}>
          {loading && <div className="row muted" style={{ justifyContent: "center", padding: 24, gap: 8 }}><span className="spinner" />加载中...</div>}
          {!loading && folders.length === 0 && (
            <div className="empty-state" style={{ padding: 36 }}>
              <div className="empty-icon"><FolderOpen size={22} /></div>
              <strong>没有子文件夹</strong>
              <span>点「移动到此处」把项目放到当前位置</span>
            </div>
          )}
          {!loading && folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className="nav-item"
              style={{ width: "100%", padding: "10px 16px", borderRadius: 0 }}
              onClick={() => openFolder(folder)}
            >
              <FolderIcon size={16} />
              <span className="nav-item-label" style={{ flex: 1, textAlign: "left" }}>{folder.name}</span>
              <ChevronRight size={14} style={{ color: "var(--fg-subtle)" }} />
            </button>
          ))}
        </div>

        <p className="muted" style={{ fontSize: 12 }}>
          <ChevronLeft size={11} style={{ verticalAlign: -1 }} /> 点面包屑回上级 · 点列表里的文件夹进入 · 点底部按钮把项目放到当前位置
        </p>
      </div>
    </Dialog>
  );
}
