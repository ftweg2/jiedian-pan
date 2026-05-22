import { useEffect, useState } from "react";
import { api, type SessionUser } from "./api.js";
import { Login } from "./pages/Login.js";
import { ShareView } from "./pages/ShareView.js";
import { Workspace } from "./pages/Workspace.js";

export function App() {
  const shareToken = getShareToken();
  if (shareToken) return <ShareView token={shareToken} />;
  return <Dashboard />;
}

function Dashboard() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    api<{ user: SessionUser }>("/auth/me")
      .then((response) => setUser(response.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) return <div className="boot">Wangpan</div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}

function getShareToken(): string | null {
  const match = window.location.pathname.match(/^\/share\/([^/]+)/);
  return match?.[1] ?? null;
}
