// Client island: the signed-in user's avatar button at the far right of the
// header. Clicking it opens a dropdown with the account links (Settings,
// Admin) and Logout. Display preferences live in the separate cog SettingsMenu,
// not here.
//
// When no GitHub avatar is linked we render a generated placeholder: a colored
// circle with the user's first initial, the color derived from the username so
// it stays stable per user.

import { useEffect, useRef, useState, type ReactElement } from "react";

interface Props {
  /** Signed-in user's name; drives the placeholder initial and the menu header. */
  username: string;
  /** Whether the signed-in user is an admin; gates the Admin link. */
  isAdmin?: boolean;
  /** Linked GitHub username for avatar display, if set. */
  githubUsername?: string | null;
}

/** Stable hue in [0, 360) derived from the username, for the placeholder color. */
function hueForName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0; // keep in 32-bit range
  }
  return Math.abs(hash) % 360;
}

export default function UserMenu({
  username,
  isAdmin = false,
  githubUsername = null,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function handleLogout(): Promise<void> {
    setLoading(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.ok) {
        window.location.href = "/login";
      }
    } catch (err) {
      console.error("Logout failed:", err);
    } finally {
      setLoading(false);
    }
  }

  const avatarSrc = githubUsername
    ? `https://avatars.githubusercontent.com/${encodeURIComponent(githubUsername)}?size=64`
    : null;
  const initial = (username.trim()[0] ?? "?").toUpperCase();

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${username}`}
        title={username}
        onClick={() => setOpen((v) => !v)}
      >
        {avatarSrc ? (
          <img className="user-menu-avatar" src={avatarSrc} alt="" width={28} height={28} />
        ) : (
          <span
            className="user-menu-avatar user-menu-avatar-placeholder"
            style={{ backgroundColor: `hsl(${hueForName(username)} 55% 45%)` }}
            aria-hidden="true"
          >
            {initial}
          </span>
        )}
      </button>

      {open && (
        <div className="user-menu-dropdown" role="menu">
          <div className="user-menu-name" title={username}>
            {username}
          </div>
          <div className="user-menu-divider" role="separator" />
          <a href="/settings" className="user-menu-item" role="menuitem">
            Settings
          </a>
          {isAdmin && (
            <a href="/admin" className="user-menu-item" role="menuitem">
              Admin
            </a>
          )}
          <button
            type="button"
            className="user-menu-item user-menu-logout"
            role="menuitem"
            onClick={handleLogout}
            disabled={loading}
          >
            {loading ? "Logging out…" : "Logout"}
          </button>
        </div>
      )}
    </div>
  );
}
