import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type AccessLog,
  type AccessLogList,
  type FileItem,
  type FolderItem,
  type NodeItem,
  type SessionUser,
  type UserList
} from "../api.js";
import { Sidebar } from "../components/Sidebar.js";
import { Topbar } from "../components/Topbar.js";
import { ToastRegion } from "../components/Toast.js";
import { UploadDialog } from "../dialogs/Upload.js";
import { ActivityPanel } from "../panels/Activity.js";
import { FilesPanel } from "../panels/Files.js";
import { LogsPanel } from "../panels/Logs.js";
import { NodesPanel } from "../panels/Nodes.js";
import { TrashPanel } from "../panels/Trash.js";
import { UsersPanel } from "../panels/Users.js";
import { stage8ErrorMessage } from "../lib/errors.js";
import { useShortcuts } from "../lib/useShortcuts.js";
import { useToast } from "../lib/useToast.js";
import { useUploadController } from "../lib/useUploadController.js";
import { UploadCloud } from "lucide-react";
import type { View } from "../lib/types.js";

const COLLAPSE_KEY = "wangpan:sidebar-collapsed";

export function Workspace({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [view, setView] = useState<View>("files");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [logs, setLogs] = useState<AccessLog[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [currentFolder, setCurrentFolder] = useState<FolderItem | null>(null);
  const [folderPath, setFolderPath] = useState<FolderItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const filesRequestRef = useRef(0);
  const [pendingDetail, setPendingDetail] = useState<FileItem | null>(null);

  const toast = useToast();

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const loadFiles = useCallback(async (folderId: string | null, options: { quiet?: boolean } = {}) => {
    const requestId = filesRequestRef.current + 1;
    filesRequestRef.current = requestId;
    if (!options.quiet) setFilesLoading(true);
    const folderQuery = folderId ? `?parentId=${folderId}` : "";
    const fileQuery = folderId ? `?folderId=${folderId}` : "";
    try {
      const [folderResponse, fileResponse] = await Promise.all([
        api<{ folders: FolderItem[] }>(`/folders${folderQuery}`),
        api<{ files: FileItem[] }>(`/files${fileQuery}`)
      ]);
      if (requestId !== filesRequestRef.current) return;
      setFolders(folderResponse.folders);
      setFiles(fileResponse.files);
    } finally {
      if (requestId === filesRequestRef.current) setFilesLoading(false);
    }
  }, []);

  const loadAdminData = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (user.role !== "admin") return;
    if (!options.quiet) setAdminLoading(true);
    try {
      const [nodeResponse, userResponse, logResponse] = await Promise.all([
        api<{ nodes: NodeItem[] }>("/nodes"),
        api<UserList>("/users"),
        api<AccessLogList>("/access-logs?pageSize=25&page=1")
      ]);
      setNodes(nodeResponse.nodes);
      setUsers(userResponse.users);
      setLogs(logResponse.logs ?? logResponse.items ?? []);
    } finally {
      if (!options.quiet) setAdminLoading(false);
    }
  }, [user.role]);

  useEffect(() => {
    loadFiles(null).catch((err) => toast.error((err as Error).message));
    loadAdminData().catch((err) => toast.error(stage8ErrorMessage(err, "读取管理数据")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploads = useUploadController({
    onUploaded: async (count, firstName) => {
      await loadFiles(currentFolderId, { quiet: true });
      toast.success(count === 1 ? `${firstName} 已上传` : `${count} 个文件已上传`);
    },
    onError: toast.error
  });

  async function logout() {
    await api("/auth/logout", { method: "POST", body: "{}" });
    onLogout();
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await loadFiles(currentFolderId);
      await loadAdminData({ quiet: true });
      toast.success("已刷新");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  function openRoot() {
    setCurrentFolderId(null);
    setCurrentFolder(null);
    setFolderPath([]);
    loadFiles(null).catch((err) => toast.error((err as Error).message));
  }

  function openFolder(folder: FolderItem) {
    setCurrentFolderId(folder.id);
    setCurrentFolder(folder);
    setFolderPath((path) => {
      const existing = path.findIndex((entry) => entry.id === folder.id);
      return existing >= 0 ? path.slice(0, existing + 1) : [...path, folder];
    });
    loadFiles(folder.id).catch((err) => toast.error((err as Error).message));
  }

  function openPathFolder(index: number) {
    if (index < 0) { openRoot(); return; }
    const folder = folderPath[index];
    if (!folder) return;
    setCurrentFolderId(folder.id);
    setCurrentFolder(folder);
    setFolderPath(folderPath.slice(0, index + 1));
    loadFiles(folder.id).catch((err) => toast.error((err as Error).message));
  }

  useShortcuts([
    { key: "b", handler: () => setCollapsed((c) => !c) },
    { key: "r", handler: () => { if (!refreshing) refresh(); } }
  ]);

  return (
    <div className={`app-shell ${collapsed ? "is-collapsed" : ""}`}>
      <Sidebar view={view} user={user} collapsed={collapsed} onChange={setView} onLogout={logout} />

      <section className="workspace">
        <Topbar
          title={viewTitle(view)}
          meta={user.name}
          collapsed={collapsed}
          onToggleSidebar={() => setCollapsed((c) => !c)}
          onRefresh={refresh}
          refreshing={refreshing}
        >
          {uploads.queue.length > 0 && (
            <button
              type="button"
              className={`btn btn-sm ${uploads.hasInFlight ? "btn-primary" : "btn-secondary"}`}
              onClick={() => uploads.openDialog({
                folderId: currentFolderId,
                folderPolicy: (currentFolder?.defaultPolicy as "standard" | "important" | "temporary" | undefined) ?? "standard"
              })}
              title="查看上传队列"
            >
              {uploads.hasInFlight && <span className="spinner" />}
              <UploadCloud size={13} />
              {uploads.hasInFlight ? `上传中 ${uploads.inFlightCount}/${uploads.queue.length}` : `队列 ${uploads.queue.length} 项`}
            </button>
          )}
        </Topbar>

        <main className="page">
          {view === "files" && (
            <FilesPanel
              folders={folders}
              files={files}
              currentFolder={currentFolder}
              currentFolderId={currentFolderId}
              folderPath={folderPath}
              openRoot={openRoot}
              openFolder={openFolder}
              openPathFolder={openPathFolder}
              reload={() => loadFiles(currentFolderId, { quiet: true })}
              loading={filesLoading}
              toastSuccess={toast.success}
              toastError={toast.error}
              initialDetailFile={pendingDetail}
              onInitialDetailShown={() => setPendingDetail(null)}
              onOpenUpload={() => uploads.openDialog({
                folderId: currentFolderId,
                folderPolicy: (currentFolder?.defaultPolicy as "standard" | "important" | "temporary" | undefined) ?? "standard"
              })}
              onDropFiles={(files) => {
                uploads.openDialog({
                  folderId: currentFolderId,
                  folderPolicy: (currentFolder?.defaultPolicy as "standard" | "important" | "temporary" | undefined) ?? "standard"
                });
                uploads.addFiles(files);
              }}
            />
          )}

          {view === "activity" && (
            <ActivityPanel
              files={files}
              folders={folders}
              nodes={nodes}
              loading={filesLoading}
              canOpenNodes={user.role === "admin"}
              onOpenFile={(file) => { setPendingDetail(file); setView("files"); }}
              onOpenNodes={() => setView("nodes")}
            />
          )}

          {view === "trash" && (
            <TrashPanel
              toastSuccess={toast.success}
              toastError={toast.error}
              onOpenFile={(file) => { setPendingDetail(file); setView("files"); }}
            />
          )}

          {view === "nodes" && user.role === "admin" && (
            <NodesPanel nodes={nodes} loading={adminLoading} reload={loadAdminData} toastSuccess={toast.success} toastError={toast.error} />
          )}

          {view === "users" && user.role === "admin" && (
            <UsersPanel users={users} loading={adminLoading} reload={loadAdminData} toastSuccess={toast.success} toastError={toast.error} />
          )}

          {view === "logs" && user.role === "admin" && (
            <LogsPanel initialLogs={logs} loading={adminLoading} />
          )}
        </main>
      </section>

      <UploadDialog controller={uploads} />
      <ToastRegion toasts={toast.toasts} onDismiss={toast.dismiss} />
    </div>
  );
}

function viewTitle(view: View): string {
  return { files: "我的文件", trash: "回收站", activity: "动态", nodes: "存储节点", users: "用户", logs: "访问记录" }[view];
}
