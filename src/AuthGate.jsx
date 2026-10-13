import { useEffect, useState } from "react";

const TASK_POLL_MS = 2500;
const TASK_TIMEOUT_MS = 16 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function apiPath(input) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (!raw) return null;
  const url = new URL(raw, window.location.href);
  return url.origin === window.location.origin && url.pathname.startsWith("/api/import/") ? url.pathname : null;
}

// Long AI requests answer 202 with an x-task-id header while a background
// function does the work. Poll until it finishes and return the real response.
async function waitForTask(nativeFetch, taskId) {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(TASK_POLL_MS);
    let response;
    try {
      response = await nativeFetch(`/api/import/tasks/${taskId}`, { cache: "no-store" });
    } catch {
      continue;
    }
    if (!response.ok) return response;
    const data = await response.json();
    if (data.status === "done") {
      return new Response(data.response.body, {
        status: data.response.status,
        headers: { "Content-Type": data.response.contentType || "application/json; charset=utf-8" },
      });
    }
  }
  return new Response(JSON.stringify({ error: "הפעולה נמשכה יותר מדי זמן. נסו שוב." }), {
    status: 504,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

let installed = false;
function installApiFetch(onUnauthorized) {
  if (installed) return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const pathname = apiPath(input);
    if (!pathname) return response;
    if (response.status === 401 && pathname !== "/api/import/session" && pathname !== "/api/import/login") {
      onUnauthorized();
    }
    const taskId = response.headers.get("x-task-id");
    if (response.status === 202 && taskId) return waitForTask(nativeFetch, taskId);
    return response;
  };
}

function LoginScreen({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/import/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "לא ניתן להתחבר כרגע.");
      onSuccess();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-screen" dir="rtl">
      <form className="login-card" onSubmit={submit}>
        <h1>המלתחה שלי</h1>
        <p>הזינו את הסיסמה כדי להיכנס.</p>
        <input
          type="password"
          autoComplete="current-password"
          aria-label="סיסמה"
          placeholder="סיסמה"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy || !password}>
          {busy ? "מתחבר..." : "כניסה"}
        </button>
      </form>
    </main>
  );
}

export function AuthGate({ children }) {
  const [state, setState] = useState("checking");

  useEffect(() => {
    installApiFetch(() => setState("login"));
    fetch("/api/import/session", { cache: "no-store" })
      .then((response) => setState(response.status === 401 ? "login" : "ready"))
      // Offline: show the cached app rather than a login wall
      .catch(() => setState("ready"));
  }, []);

  if (state === "checking") return null;
  if (state === "login") return <LoginScreen onSuccess={() => setState("ready")} />;
  return children;
}
