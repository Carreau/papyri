import { useState } from "react";

interface Props {
  /** Whether the signed-in user is an admin; gates the Admin link. */
  isAdmin?: boolean;
}

export default function UserMenu({ isAdmin = false }: Props) {
  const [loading, setLoading] = useState(false);

  const handleLogout = async () => {
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
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      {isAdmin && (
        <a
          href="/admin"
          style={{
            padding: "6px 12px",
            backgroundColor: "transparent",
            border: "1px solid #ddd",
            borderRadius: "4px",
            fontSize: "14px",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          Admin
        </a>
      )}
      <a
        href="/settings"
        style={{
          padding: "6px 12px",
          backgroundColor: "transparent",
          border: "1px solid #ddd",
          borderRadius: "4px",
          fontSize: "14px",
          textDecoration: "none",
          color: "inherit",
        }}
      >
        Settings
      </a>
      <button
        onClick={handleLogout}
        disabled={loading}
        style={{
          padding: "6px 12px",
          backgroundColor: "transparent",
          border: "1px solid #ddd",
          borderRadius: "4px",
          cursor: loading ? "not-allowed" : "pointer",
          fontSize: "14px",
          color: loading ? "#999" : "inherit",
        }}
      >
        {loading ? "Logging out…" : "Logout"}
      </button>
    </div>
  );
}
