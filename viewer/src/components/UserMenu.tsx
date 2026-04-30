import { useState } from "react";

export default function UserMenu() {
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
  );
}
