import {
  ArrowDownAZ,
  Archive,
  ChevronRight,
  Clock,
  Download,
  Edit3,
  Eye,
  File as FileIconBase,
  FileText,
  FolderPlus,
  Grid3x3,
  Image as ImageIcon,
  Info,
  Link2,
  List,
  MoreHorizontal,
  Move,
  Music,
  Search,
  Star,
  Trash2,
  UploadCloud,
  Video
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { api, download, type FileItem, type FolderItem, type StoragePolicy } from "../api.js";
import { PolicyBadge, ReplicaBadge, StatusBadge } from "../components/Badges.js";
import { Checkbox } from "../components/Checkbox.js";
import { ContextMenu, type ContextMenuEntry } from "../components/ContextMenu.js";
import { EmptyState, TableState } from "../components/Empty.js";
import { FileGlyph } from "../components/FileIcon.js";
import { ConfirmDialog } from "../dialogs/Confirm.js";
import { CreateFolderDialog } from "../dialogs/CreateFolder.js";
import { FileDetailDrawer } from "../dialogs/FileDetail.js";
import { PreviewDialog } from "../dialogs/Preview.js";
import { FolderShareDialog, ShareDialog } from "../dialogs/Share.js";
import { RenameDialog, type RenameTarget } from "../dialogs/Rename.js";
import { MoveDialog } from "../dialogs/Move.js";
import { NewFileMenu } from "../components/NewFileMenu.js";
import { TextFileEditor } from "../dialogs/TextFileEditor.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import {
  compareFiles,
  countCategory,
  fileMatchesCategory,
  type FileCategory,
  type FileViewMode,
  type SortMode
} from "../lib/category.js";
import { stage8ErrorMessage, transferErrorMessage } from "../lib/errors.js";
import { formatBytes, formatDateTime, policyLabel } from "../lib/format.js";
import { useShortcuts } from "../lib/useShortcuts.js";
import { itemKey, itemName, type BrowserItem } from "../lib/types.js";

interface FilesPanelProps {
  folders: FolderItem[];
  files: FileItem[];
  currentFolder: FolderItem | null;
  currentFolderId: string | null;
  folderPath: FolderItem[];
  openRoot: () => void;
  openFolder: (folder: FolderItem) => void;
  openPathFolder: (index: number) => void;
  reload: () => Promise<void>;
  loading: boolean;
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
  initialDetailFile: FileItem | null;
  onInitialDetailShown: () => void;
  onOpenUpload: () => void;
  onDropFiles: (files: FileList) => void;
}

const categoryOptions: Array<{ id: FileCategory; label: string; icon: typeof FileIconBase }> = [
  { id: "all", label: "全部文件", icon: FileIconBase },
  { id: "image", label: "图片", icon: ImageIcon },
  { id: "document", label: "文档", icon: FileText },
  { id: "video", label: "视频", icon: Video },
  { id: "audio", label: "音频", icon: Music },
  { id: "important", label: "重要", icon: Star },
  { id: "temporary", label: "临时", icon: Archive }
];

export function FilesPanel(props: FilesPanelProps) {
  const {
    folders, files, currentFolder, currentFolderId, folderPath,
    openRoot, openFolder, openPathFolder, reload, loading,
    toastSuccess, toastError,
    initialDetailFile, onInitialDetailShown,
    onOpenUpload, onDropFiles
  } = props;

  const [query, setQuery] = useState("");
  const [globalSearch, setGlobalSearch] = useState(false);
  const [globalResults, setGlobalResults] = useState<FileItem[] | null>(null);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [category, setCategory] = useState<FileCategory>("all");
  const [sortMode, setSortMode] = useState<SortMode>("time");
  const [viewMode, setViewMode] = useState<FileViewMode>("list");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  // Text editor (txt/md): when set, full-screen editor opens. Driven both by
  // clicking an existing txt/md/word file in the list AND by 新建文件 menu.
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingFileName, setEditingFileName] = useState<string>("");
  const [editingFileMime, setEditingFileMime] = useState<string>("");
  const [shareFile, setShareFile] = useState<FileItem | null>(null);
  const [shareFolder, setShareFolder] = useState<FolderItem | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [moveTargets, setMoveTargets] = useState<BrowserItem[] | null>(null);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [detailFile, setDetailFile] = useState<FileItem | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<BrowserItem[] | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: BrowserItem } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const browserRef = useRef<HTMLDivElement | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const globalSearchActive = globalSearch && normalizedQuery.length > 0;

  const visibleFolders = useMemo(() => {
    if (globalSearchActive) return []; // 全局搜索时不展示文件夹(目录路径会写在 sub-line)
    if (category !== "all" && normalizedQuery.length === 0) return [];
    return folders.filter((folder) => folder.name.toLowerCase().includes(normalizedQuery));
  }, [folders, category, normalizedQuery, globalSearchActive]);

  const visibleFiles = useMemo(() => {
    if (globalSearchActive && globalResults) {
      return [...globalResults]
        .filter((file) => fileMatchesCategory(file, category))
        .sort((a, b) => compareFiles(a, b, sortMode));
    }
    return [...files]
      .filter((file) => fileMatchesCategory(file, category) && file.name.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => compareFiles(a, b, sortMode));
  }, [files, category, normalizedQuery, sortMode, globalSearchActive, globalResults]);

  // Debounced cross-folder search
  useEffect(() => {
    if (!globalSearchActive) {
      setGlobalResults(null);
      return;
    }
    const handle = window.setTimeout(async () => {
      setGlobalSearchLoading(true);
      try {
        const res = await api<{ files: FileItem[] }>(`/files?q=${encodeURIComponent(query.trim())}&recursive=1`);
        setGlobalResults(res.files);
      } catch (err) {
        toastError(err instanceof Error ? err.message : "搜索失败");
      } finally {
        setGlobalSearchLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [globalSearchActive, query, toastError]);

  const visibleItems: BrowserItem[] = useMemo(() => [
    ...visibleFolders.map((folder) => ({ kind: "folder" as const, id: folder.id, folder })),
    ...visibleFiles.map((file) => ({ kind: "file" as const, id: file.id, file }))
  ], [visibleFolders, visibleFiles]);

  const isEmpty = !loading && folders.length === 0 && files.length === 0;
  const filteredEmpty = !loading && !isEmpty && visibleItems.length === 0;
  const importantAtRisk = files.filter((file) => file.effectivePolicy === "important" && file.status !== "deleted" && file.replicaCount < 2);

  const selectedItems = visibleItems.filter((item) => selectedIds.has(itemKey(item)));
  const selectedFiles = files.filter((file) => selectedIds.has(`file:${file.id}`));
  const allSelected = visibleItems.length > 0 && visibleItems.every((item) => selectedIds.has(itemKey(item)));
  const someSelected = selectedIds.size > 0 && !allSelected;

  useEffect(() => {
    setSelectedIds(new Set());
    setContextMenu(null);
  }, [currentFolderId, category]);

  useEffect(() => {
    setDetailFile((current) => current ? files.find((file) => file.id === current.id) ?? null : null);
  }, [files]);

  useEffect(() => {
    if (!initialDetailFile) return;
    setDetailFile(initialDetailFile);
    setSelectedIds(new Set([`file:${initialDetailFile.id}`]));
    onInitialDetailShown();
  }, [initialDetailFile, onInitialDetailShown]);

  // selection helpers
  function toggleItem(item: BrowserItem) {
    const key = itemKey(item);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function selectOnly(item: BrowserItem) {
    setSelectedIds(new Set([itemKey(item)]));
    // 不再自动打开详情抽屉 — 详情只在 openDetails(右键菜单 / ⓘ 按钮 / 来自其他面板的跳转)时显示。
  }
  function toggleAll() {
    setSelectedIds(() => {
      if (allSelected) return new Set();
      return new Set(visibleItems.map(itemKey));
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  // actions
  const saveFile = useCallback(async (file: FileItem) => {
    setBusyAction(`download:${file.id}`);
    try {
      await download(`/files/${file.id}/download`, file.name);
      toastSuccess(`${file.name} 已开始下载`);
    } catch (err) {
      toastError(transferErrorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }, [toastError, toastSuccess]);

  async function downloadSelected() {
    if (selectedFiles.length === 0) return;
    setBusyAction("batch-download");
    try {
      for (const file of selectedFiles) {
        await download(`/files/${file.id}/download`, file.name);
      }
      toastSuccess(selectedFiles.length === 1 ? `${selectedFiles[0].name} 已下载` : `${selectedFiles.length} 个文件已下载`);
    } catch (err) {
      toastError(transferErrorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function removeTargets() {
    if (!deleteTargets) return;
    setBusyAction("delete");
    try {
      for (const item of deleteTargets) {
        await api(item.kind === "folder" ? `/folders/${item.folder.id}` : `/files/${item.file.id}`, { method: "DELETE" });
      }
      clearSelection();
      await reload();
      toastSuccess(deleteTargets.length === 1 ? `${itemName(deleteTargets[0])} 已移入回收站` : `${deleteTargets.length} 项已移入回收站`);
      setDeleteTargets(null);
    } catch (err) {
      toastError(stage8ErrorMessage(err, "移入回收站"));
    } finally {
      setBusyAction(null);
    }
  }

  function activate(item: BrowserItem) {
    if (item.kind === "folder") return openFolder(item.folder);
    // txt / md / docx → open the in-browser editor instead of the preview.
    // (docx still falls back to a download CTA inside the editor until
    // Phase B ONLYOFFICE lands.)
    if (isEditableFile(item.file)) {
      setEditingFileId(item.file.id);
      setEditingFileName(item.file.name);
      setEditingFileMime(item.file.mimeType);
      return;
    }
    setPreviewFile(item.file);
  }
  function openDetails(item: BrowserItem) {
    if (item.kind === "folder") openFolder(item.folder);
    else { selectOnly(item); setDetailFile(item.file); }
  }
  function handleRowClick(event: MouseEvent, item: BrowserItem) {
    setContextMenu(null);
    if (event.metaKey || event.ctrlKey) toggleItem(item);
    else selectOnly(item);
  }
  function openContextMenu(event: MouseEvent, item: BrowserItem) {
    event.preventDefault();
    if (!selectedIds.has(itemKey(item))) selectOnly(item);
    setContextMenu({ x: event.clientX, y: event.clientY, item });
  }

  function contextMenuEntries(item: BrowserItem): ContextMenuEntry[] {
    if (item.kind === "folder") {
      return [
        { key: "open", label: "打开", icon: <ChevronRight size={14} />, onClick: () => openFolder(item.folder) },
        { key: "rename", label: "重命名", icon: <Edit3 size={14} />, onClick: () => setRenameTarget({ kind: "folder", folder: item.folder }) },
        { key: "move", label: "移动到...", icon: <Move size={14} />, onClick: () => setMoveTargets([item]) },
        { key: "share", label: "分享文件夹", icon: <Link2 size={14} />, onClick: () => setShareFolder(item.folder) },
        { key: "div", divider: true },
        { key: "delete", label: "移入回收站", icon: <Trash2 size={14} />, danger: true, onClick: () => setDeleteTargets([item]) }
      ];
    }
    const editable = isEditableFile(item.file);
    return [
      ...(editable
        ? [{
            key: "edit",
            label: "在线编辑",
            icon: <Edit3 size={14} />,
            onClick: () => {
              setEditingFileId(item.file.id);
              setEditingFileName(item.file.name);
              setEditingFileMime(item.file.mimeType);
            }
          } satisfies ContextMenuEntry]
        : []),
      { key: "preview", label: "预览", icon: <Eye size={14} />, onClick: () => setPreviewFile(item.file) },
      { key: "details", label: "查看详情", icon: <Info size={14} />, onClick: () => openDetails(item) },
      { key: "download", label: "下载", icon: <Download size={14} />, onClick: () => saveFile(item.file), disabled: busyAction === `download:${item.file.id}` },
      { key: "rename", label: "重命名", icon: <Edit3 size={14} />, onClick: () => setRenameTarget({ kind: "file", file: item.file }) },
      { key: "move", label: "移动到...", icon: <Move size={14} />, onClick: () => setMoveTargets([item]) },
      { key: "share", label: "分享", icon: <Link2 size={14} />, onClick: () => setShareFile(item.file), disabled: item.file.status !== "active" },
      { key: "div", divider: true },
      { key: "delete", label: "移入回收站", icon: <Trash2 size={14} />, danger: true, onClick: () => setDeleteTargets([item]) }
    ];
  }

  // shortcuts
  useShortcuts([
    { key: "/", handler: (event) => { event.preventDefault(); searchInputRef.current?.focus(); } },
    { key: "a", meta: true, handler: (event) => { event.preventDefault(); toggleAll(); } },
    { key: "Escape", handler: () => { setContextMenu(null); clearSelection(); } },
    { key: "Delete", handler: () => { if (selectedItems.length > 0) setDeleteTargets(selectedItems); }, when: () => selectedItems.length > 0 },
    { key: "Backspace", handler: () => { if (selectedItems.length > 0) setDeleteTargets(selectedItems); }, when: () => selectedItems.length > 0 },
    {
      key: "F2",
      handler: () => {
        if (selectedItems.length !== 1) return;
        const only = selectedItems[0];
        setRenameTarget(only.kind === "folder"
          ? { kind: "folder", folder: only.folder }
          : { kind: "file", file: only.file });
      },
      when: () => selectedItems.length === 1
    }
  ]);

  // drag-drop upload — anywhere in main area
  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      setDragOver(true);
    }
  }
  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget === event.target) setDragOver(false);
  }
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      onDropFiles(event.dataTransfer.files);
    }
  }

  return (
    <div className="files-shell">
      <aside className="category-rail" onClick={(event) => event.stopPropagation()}>
        {categoryOptions.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.id}
              type="button"
              className={`nav-item ${category === option.id ? "is-active" : ""}`}
              onClick={() => setCategory(option.id)}
            >
              <Icon size={15} />
              <span className="nav-item-label">{option.label}</span>
              <small>{countCategory(files, option.id)}</small>
            </button>
          );
        })}
      </aside>

      <section className="files-main" ref={browserRef}>
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={onOpenUpload}>
            <UploadCloud size={14} /> 上传
          </button>
          <NewFileMenu
            folderId={currentFolderId}
            onCreated={async (file) => {
              await reload();
              // Open editor right away on the new file.
              setEditingFileId(file.id);
              setEditingFileName(file.name);
              setEditingFileMime(file.mimeType);
            }}
            toastError={toastError}
          />
          <button type="button" className="btn btn-secondary" onClick={() => setCreateFolderOpen(true)}>
            <FolderPlus size={14} /> 新建文件夹
          </button>
          <span className="toolbar-spacer" />
          <div className="input-search" style={{ width: 240 }}>
            <Search size={14} />
            <input
              ref={searchInputRef}
              className="input"
              placeholder={globalSearch ? "在全部文件夹中搜索" : "搜索当前目录 (/)"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button
            type="button"
            className={`btn btn-sm ${globalSearch ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setGlobalSearch((v) => !v)}
            title={globalSearch ? "切回当前目录搜索" : "切到全局搜索"}
          >
            {globalSearch ? "全局" : "当前"}
          </button>
          <div className="row" style={{ gap: 4 }}>
            <ArrowDownAZ size={14} className="muted" />
            <select className="select" style={{ height: 32, width: "auto" }} value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="排序">
              <option value="time">按时间</option>
              <option value="name">按名称</option>
              <option value="size">按大小</option>
            </select>
          </div>
          <div className="view-toggle" role="tablist" aria-label="视图">
            <button type="button" className={viewMode === "list" ? "is-active" : ""} onClick={() => setViewMode("list")} title="列表"><List size={14} /></button>
            <button type="button" className={viewMode === "grid" ? "is-active" : ""} onClick={() => setViewMode("grid")} title="网格"><Grid3x3 size={14} /></button>
          </div>
        </div>

        <div className="row-between">
          <div className="breadcrumb">
            <button type="button" className={`crumb ${currentFolderId === null ? "is-current" : ""}`} onClick={openRoot}>全部文件</button>
            {folderPath.map((folder, index) => (
              <span key={folder.id} className="row" style={{ gap: 0 }}>
                <span className="sep"><ChevronRight size={14} /></span>
                <button type="button" className={`crumb ${currentFolder?.id === folder.id ? "is-current" : ""}`} onClick={() => openPathFolder(index)}>
                  {folder.name}
                </button>
              </span>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {globalSearchActive
              ? (globalSearchLoading ? "搜索中..." : `全局搜索 · ${visibleFiles.length} 个文件`)
              : `${visibleFolders.length} 个文件夹 · ${visibleFiles.length} 个文件`}
          </span>
        </div>

        {importantAtRisk.length > 0 && (
          <div className="alert alert-warn">
            <Star size={14} />
            <div>
              <strong>{importantAtRisk.length} 个重要文件副本不足</strong>
              <span> · 打开文件详情查看副本状态</span>
            </div>
          </div>
        )}

        <div
          className={`dropzone ${dragOver ? "is-active" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragOver && <div className="drop-banner">松开后打开上传窗口</div>}

          {viewMode === "list" ? (
            <div className="table-wrap">
              <table className="file-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <Checkbox checked={allSelected} indeterminate={someSelected} onChange={toggleAll} label="全选" />
                    </th>
                    <th>名称</th>
                    <th>策略</th>
                    <th>副本</th>
                    <th>状态</th>
                    <th>大小</th>
                    <th>修改时间</th>
                    <th className="col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <TableState colSpan={8}><span className="spinner" /> 加载中...</TableState>}
                  {isEmpty && (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState icon={<UploadCloud size={20} />} title="此目录还没有文件" hint="点击上传或拖拽文件到这里开始" />
                      </td>
                    </tr>
                  )}
                  {filteredEmpty && (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState icon={<Search size={20} />} title="没有匹配结果" hint="换个关键词,或切换分类" />
                      </td>
                    </tr>
                  )}
                  {visibleItems.map((item) => {
                    const selected = selectedIds.has(itemKey(item));
                    const warning = item.kind === "file" && item.file.effectivePolicy === "important" && item.file.replicaCount < 2;
                    return (
                      <tr
                        key={itemKey(item)}
                        className={`${selected ? "is-selected" : ""} ${warning ? "is-warning" : ""}`}
                        onClick={(event) => handleRowClick(event, item)}
                        onDoubleClick={() => activate(item)}
                        onContextMenu={(event) => openContextMenu(event, item)}
                      >
                        <td className="col-check" onClick={(event) => event.stopPropagation()}>
                          <Checkbox checked={selected} onChange={() => toggleItem(item)} />
                        </td>
                        <td>
                          <div className="file-cell">
                            <span className={`file-glyph ${item.kind === "folder" ? "folder" : ""}`}>
                              <FileGlyph item={item} size={16} />
                            </span>
                            <div className="file-meta">
                              <span className="file-name">{item.kind === "folder" ? item.folder.name : item.file.name}</span>
                              <span className="file-sub">
                                {item.kind === "folder" ? "文件夹" : (
                                  item.file.expiresAt ? <><Clock size={11} style={{ verticalAlign: -1, marginRight: 2 }} />{formatDateTime(item.file.expiresAt)} 到期</> : (item.file.mimeType || "文件")
                                )}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>{item.kind === "folder" ? <PolicyBadge policy={item.folder.defaultPolicy} /> : <PolicyBadge policy={item.file.effectivePolicy} />}</td>
                        <td>{item.kind === "folder" ? <span className="muted" style={{ fontSize: 12 }}>—</span> : <ReplicaBadge file={item.file} />}</td>
                        <td>{item.kind === "folder" ? <span className="muted" style={{ fontSize: 12 }}>—</span> : <StatusBadge status={item.file.status} />}</td>
                        <td className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                          {item.kind === "folder" ? "—" : formatBytes(Number(item.file.sizeBytes))}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>{item.kind === "folder" ? "—" : formatDateTime(item.file.createdAt)}</td>
                        <td className="col-actions">
                          <button type="button" className="icon-btn" onClick={(event) => { event.stopPropagation(); openDetails(item); }} title="详情">
                            {item.kind === "file" ? <Info size={14} /> : <ChevronRight size={14} />}
                          </button>
                          <button type="button" className="icon-btn" onClick={(event) => { event.stopPropagation(); openContextMenu(event, item); }} title="更多">
                            <MoreHorizontal size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              {loading && <div className="row muted" style={{ justifyContent: "center", gap: 8, padding: 24 }}><span className="spinner" /> 加载中...</div>}
              {isEmpty && <EmptyState icon={<UploadCloud size={20} />} title="此目录还没有文件" hint="点击上传或拖拽文件到这里开始" />}
              {filteredEmpty && <EmptyState icon={<Search size={20} />} title="没有匹配结果" hint="换个关键词,或切换分类" />}
              <div className="file-grid">
                {visibleItems.map((item) => {
                  const selected = selectedIds.has(itemKey(item));
                  return (
                    <div
                      key={itemKey(item)}
                      className={`file-tile ${selected ? "is-selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={(event) => handleRowClick(event, item)}
                      onDoubleClick={() => activate(item)}
                      onContextMenu={(event) => openContextMenu(event, item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") activate(item);
                        if (event.key === " ") { event.preventDefault(); toggleItem(item); }
                      }}
                    >
                      <span className="tile-check" onClick={(event) => event.stopPropagation()}>
                        <Checkbox checked={selected} onChange={() => toggleItem(item)} />
                      </span>
                      <span className={`file-glyph ${item.kind === "folder" ? "folder" : ""}`}>
                        <FileGlyph item={item} size={28} />
                      </span>
                      <span className="file-name">{item.kind === "folder" ? item.folder.name : item.file.name}</span>
                      <span className="file-sub">
                        {item.kind === "folder" ? policyLabel(item.folder.defaultPolicy) : `${formatBytes(Number(item.file.sizeBytes))} · ${policyLabel(item.file.effectivePolicy)}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </section>

      {selectedItems.length > 0 && (
        <div className="action-bar" role="toolbar" aria-label="批量操作">
          <span className="action-bar-count">{selectedItems.length}</span>
          <button type="button" className="btn btn-sm" onClick={downloadSelected} disabled={selectedFiles.length === 0 || busyAction === "batch-download"}>
            <Download size={13} /> 下载
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setMoveTargets(selectedItems)}>
            <Move size={13} /> 移动
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => selectedFiles.length === 1 && setShareFile(selectedFiles[0])}
            disabled={selectedFiles.length !== 1 || selectedFiles[0]?.status !== "active"}
          >
            <Link2 size={13} /> 分享
          </button>
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => setDeleteTargets(selectedItems)}>
            <Trash2 size={13} /> 移入回收站
          </button>
          <span className="divider" />
          <button type="button" className="btn btn-sm" onClick={clearSelection}>清除</button>
        </div>
      )}

      {createFolderOpen && (
        <CreateFolderDialog
          parentId={currentFolderId}
          onCreated={async () => {
            await reload();
            toastSuccess("文件夹已创建");
          }}
          onError={toastError}
          onClose={() => setCreateFolderOpen(false)}
        />
      )}

      {editingFileId && (
        <ErrorBoundary label="文件编辑器">
          <TextFileEditor
            fileId={editingFileId}
            fileName={editingFileName}
            mimeType={editingFileMime}
            onClose={() => setEditingFileId(null)}
            onSaved={async () => { await reload(); toastSuccess("已保存"); }}
            toastError={toastError}
          />
        </ErrorBoundary>
      )}

      {deleteTargets && (
        <ConfirmDialog
          title={`移入回收站`}
          message={
            deleteTargets.length === 1
              ? deleteTargets[0].kind === "folder"
                ? `确定将文件夹「${deleteTargets[0].folder.name}」移入回收站吗?里面的子文件夹和文件也会一起进入回收站。`
                : `确定将「${deleteTargets[0].file.name}」移入回收站吗?`
              : `确定将选中的 ${deleteTargets.length} 项移入回收站吗?`
          }
          confirmLabel="移入回收站"
          danger
          busy={busyAction === "delete"}
          onCancel={() => setDeleteTargets(null)}
          onConfirm={removeTargets}
        />
      )}

      {shareFile && <ShareDialog file={shareFile} onClose={() => setShareFile(null)} />}
      {shareFolder && <FolderShareDialog folder={shareFolder} onClose={() => setShareFolder(null)} />}

      {renameTarget && (
        <RenameDialog
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={async () => {
            await reload();
            toastSuccess(renameTarget.kind === "folder" ? "文件夹已重命名" : "文件已重命名");
          }}
          onError={toastError}
        />
      )}

      {moveTargets && (
        <MoveDialog
          targets={{ items: moveTargets, currentParentId: currentFolderId }}
          onClose={() => setMoveTargets(null)}
          onMoved={async () => {
            clearSelection();
            await reload();
            toastSuccess(moveTargets.length === 1 ? "已移动" : `${moveTargets.length} 项已移动`);
          }}
          onError={toastError}
        />
      )}

      {previewFile && (
        <PreviewDialog
          file={previewFile}
          onClose={() => setPreviewFile(null)}
          onDownload={() => saveFile(previewFile)}
          onShare={() => { setShareFile(previewFile); setPreviewFile(null); }}
        />
      )}

      {detailFile && (
        <FileDetailDrawer
          file={detailFile}
          onClose={() => setDetailFile(null)}
          onPreview={() => setPreviewFile(detailFile)}
          onDownload={() => saveFile(detailFile)}
          onShare={() => setShareFile(detailFile)}
          onDelete={() => setDeleteTargets([{ kind: "file", id: detailFile.id, file: detailFile }])}
          busyAction={busyAction}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuEntries(contextMenu.item)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Returns true if double-clicking this file should open the in-browser editor
 * instead of the preview dialog. Whitelist by mime + extension fallback so
 * we don't misroute things like binary blobs with a .txt-ish mime.
 */
function isEditableFile(file: FileItem): boolean {
  const name = file.name.toLowerCase();
  const mime = (file.mimeType || "").toLowerCase();
  if (mime === "text/plain" || mime === "text/markdown") return true;
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return true;
  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".docx")) return true;
  return false;
}
