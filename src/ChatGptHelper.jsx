import { useRef, useState } from "react";
import { Check, Copy, DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { copyText, fileToUploadDataUrl } from "./image-files.js";

// Free route through the user's own ChatGPT subscription: copy the request the
// site would send, attach the photos in ChatGPT, then upload the result here.
export function ChatGptHelper({ getPrompt, photos = [], onUpload, uploadLabel = "העלאת התמונה שיצרתי", disabled = false }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const copy = async () => {
    setBusy("copy");
    setError("");
    try {
      const prompt = await getPrompt();
      if (!(await copyText(prompt))) throw new Error("לא הצלחנו להעתיק. נסי שוב.");
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      setError(err.message || "לא הצלחנו להעתיק.");
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file) => {
    if (!file) return;
    setBusy("upload");
    setError("");
    try {
      await onUpload(await fileToUploadDataUrl(file));
    } catch (err) {
      setError(err.message || "ההעלאה נכשלה.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gpt-helper">
      <p className="gpt-helper__title">בחינם עם המנוי ל-ChatGPT</p>
      <ol className="gpt-helper__steps">
        <li>שמרי את התמונות{photos.length ? " (כאן למטה)" : ""} ואת תמונת המודל שלך, וצרפי אותן בשיחה חדשה ב-ChatGPT. קודם את התמונה שלך, ואחריה את הבגדים.</li>
        <li>העתיקי את ההנחיה והדביקי אותה בשיחה.</li>
        <li>שמרי את התמונה שיצא והעלי אותה כאן.</li>
      </ol>
      {photos.length > 0 && (
        <div className="gpt-helper__photos">
          {photos.map((photo) => (
            <a key={photo.src} className="gpt-helper__photo" href={photo.src} download={photo.filename} target="_blank" rel="noreferrer" title={`שמירת ${photo.name}`}>
              <img src={photo.thumb || photo.src} alt="" />
              <span><DownloadSimple size={12} aria-hidden="true" /> {photo.name}</span>
            </a>
          ))}
        </div>
      )}
      <div className="gpt-helper__actions">
        <button type="button" className="secondary-button" disabled={disabled || Boolean(busy)} onClick={copy}>
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          <span>{copied ? "ההנחיה הועתקה" : busy === "copy" ? "מעתיק..." : "העתקת ההנחיה"}</span>
        </button>
        <a className="secondary-button gpt-helper__open" href="https://chatgpt.com/" target="_blank" rel="noreferrer">פתיחת ChatGPT</a>
        <button type="button" className="primary-button" disabled={disabled || Boolean(busy)} onClick={() => inputRef.current?.click()}>
          <UploadSimple size={15} aria-hidden="true" />
          <span>{busy === "upload" ? "מעלה..." : uploadLabel}</span>
        </button>
        <input ref={inputRef} type="file" accept="image/*,.heic,.heif" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; upload(file); }} />
      </div>
      {error && <p className="gpt-helper__error" role="alert">{error}</p>}
    </div>
  );
}
