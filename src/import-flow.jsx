import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import "./import-flow.css";

const API = "/api/import/jobs";
const CONFIG_API = "/api/import/config";
const PARTS = [
  ["upperbody", "חולצות"],
  ["wholebody_up", "עליוניות וז'קטים"],
  ["lowerbody", "מכנסיים"],
  ["accessories_up", "אקססוריז"],
  ["shoes", "נעליים"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("לא ניתן לקרוא תמונה זו."));
  reader.readAsDataURL(file);
});

const compressImageForUpload = async (file, maxDimension = 1200, quality = 0.82) => {
  if (!file) throw new Error("לא נבחר קובץ תמונה");

  if (typeof window !== "undefined" && typeof window.createImageBitmap === "function") {
    try {
      const bitmap = await window.createImageBitmap(file);
      let { width, height } = bitmap;
      if (width && height) {
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          if (dataUrl && dataUrl.startsWith("data:image/jpeg")) {
            return dataUrl;
          }
        }
      }
    } catch {
      // Fall through to Image
    }
  }

  return new Promise((resolve, reject) => {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        try {
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            const res = canvas.toDataURL("image/jpeg", quality);
            URL.revokeObjectURL(url);
            resolve(res);
            return;
          }
        } catch {
          // Canvas error
        }
        URL.revokeObjectURL(url);
        fileToDataUrl(file).then(resolve).catch(reject);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        fileToDataUrl(file).then(resolve).catch(reject);
      };
      img.src = url;
    } catch {
      fileToDataUrl(file).then(resolve).catch(reject);
    }
  });
};

async function api(path, options) {
  let activeWardrobe = "user-shani";
  if (typeof window !== "undefined") {
    const fromUrl = new URLSearchParams(window.location.search).get("wardrobe") || new URLSearchParams(window.location.search).get("wardrobeId");
    if (fromUrl) {
      activeWardrobe = fromUrl;
    } else {
      activeWardrobe = localStorage.getItem("active_wardrobe_id") || "user-shani";
    }
  }
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-wardrobe-id": activeWardrobe,
      ...(options?.headers || {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "לא ניתן לעדכן את תהליך הייבוא.");
  return value;
}

function deriveStatus(job) {
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  const modeled = job.stages?.modeled;
  if (job.error || crop?.status === "failed" || garment?.status === "failed" || modeled?.status === "failed") return { tone: "error", text: "דרושה התייחסות", detail: crop?.error || garment?.error || modeled?.error || job.error };
  if (modeled?.status === "review") return { tone: "ready", text: "תמונת מודל מוכנה לבדיקה" };
  if (modeled?.status === "processing") return { tone: "processing", text: "יוצר תמונה על מודל..." };
  if (garment?.status === "review") return { tone: "ready", text: "מוכן לבדיקה" };
  if (garment?.status === "approved") return { tone: "processing", text: "יוצר תמונה על מודל..." };
  if (crop?.status === "review") return { tone: "ready", text: "גזיר מוכן לבדיקה" };
  if (crop?.status === "approved") return { tone: "processing", text: "מחלץ בגד נקי..." };
  if (crop?.status === "rejected" || garment?.status === "rejected" || modeled?.status === "rejected") return { tone: "complete", text: "הייבוא בוטל" };
  return { tone: "processing", text: "מחלץ בגד מהתמונה..." };
}

function reviewStageFor(job) {
  if (job.stages?.modeled?.status === "review") return "modeled";
  if (job.stages?.garment?.status === "review") return "garment";
  if (job.stages?.crop?.status === "review") return "crop";
  return null;
}

function hasCleanupFailure(job) {
  return job.stages?.garment?.status === "failed" && Boolean(job.stages?.garment?.failedAssetUrl);
}

function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    name: metadata.name || "פריט חדש",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
  };
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, busy, onAction }) {
  const asset = job.stages[stage]?.assetUrl;
  const isCrop = stage === "crop";
  const isGarment = stage === "garment";
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      <img className="import-editor__preview" src={asset} alt={isCrop ? "גזיר פריט" : isGarment ? "בגד מחולץ" : "תמונת מודל"} />
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "פריט שזוהה" : isGarment ? "תמונת בגד" : "הדמיה על מודל"}</p>
        {isCrop ? <p className="import-card__detail">ודאו שהגזיר מכיל את הפריט המלא. אישור יתחיל חילוץ רקע נקי.</p> : isGarment ? (
          <>
            <div className="import-field"><label htmlFor={`name-${job.id}`}>שם הפריט</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>קטגוריה</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>צבע ראשי</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="צבע ראשי" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div></div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>צבע משני <span>אופציונלי</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#קוד צבע" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>מאפיינים</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="יומיומי, כותנה, פסים" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">אישור התמונה יוסיף אותה למלתחה, או שניתן ליצור מחדש עם הנחיות מדויקות.</p>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>הנחיות ליצירה מחדש <span>אופציונלי</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="2" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder="לדוגמה: לשמור על הרוכסן המקורי ולהסיר את התווית" />
        </div>}
        <div className="import-actions">
          <button className="import-button" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> דחייה</button>
          {!isCrop && <button className="import-button" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> יצירה מחדש</button>}
          <button className="import-button import-button--primary" disabled={busy || (isGarment && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction("approve")}><Check size={14} weight="bold" /> {isCrop ? "אישור גזיר" : "אישור"}</button>
        </div>
      </div>
    </div>
  );
}

function CleanupEditor({ job, tolerance, setTolerance, busy, onPreview, onAccept }) {
  const stage = job.stages.garment;
  const previewTimer = useRef(null);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const updateTolerance = (next) => {
    setTolerance(next);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => onPreview(next), 300);
  };
  return (
    <div className="import-cleanup-editor">
      <p className="import-editor__stage">ניקוי רקע</p>
      <div className="import-cleanup-comparison">
        <figure><img src={stage.failedAssetUrl} alt="" /><figcaption>מקור</figcaption></figure>
        <figure><img src={stage.cleanupPreviewUrl || stage.failedAssetUrl} alt="" /><figcaption>{stage.cleanupPreviewUrl ? "תצוגת ניקוי" : "התצוגה תופיע כאן"}</figcaption></figure>
      </div>
      <div className="import-field import-cleanup-strength">
        <label htmlFor={`cleanup-${job.id}`}>עוצמת ניקוי <strong>{tolerance}</strong></label>
        <input id={`cleanup-${job.id}`} type="range" min="18" max="110" step="2" value={tolerance} onChange={(event) => updateTolerance(Number(event.target.value))} />
      </div>
      <div className="import-actions">
        <button className="import-button" disabled={busy} onClick={() => onPreview(tolerance)}><ArrowCounterClockwise size={14} /> הצג ניקוי</button>
        <button className="import-button import-button--primary" disabled={busy} onClick={onAccept}><Check size={14} weight="bold" /> השתמש בניקוי זה</button>
      </div>
    </div>
  );
}

export function WardrobeImportFlow({ onGarmentApproved, onModeledApproved, visible = true, hidden = false }) {
  const inputRef = useRef(null);
  const modelInputRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [regenerationPrompts, setRegenerationPrompts] = useState({});
  const [cleanupTolerances, setCleanupTolerances] = useState({});
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [setup, setSetup] = useState(null);
  const [uploadingModel, setUploadingModel] = useState(false);

  const uploadModelReference = async (file) => {
    if (!file) return;
    setUploadingModel(true);
    setError("");
    try {
      if (file.size > 35 * 1024 * 1024) {
        throw new Error("קובץ התמונה גדול מדי (מעל 35MB). מומלץ לבחור תמונה רגילה מהגלריה.");
      }
      const imageDataUrl = await compressImageForUpload(file, 1200, 0.82);
      const res = await api("/api/import/model-reference", {
        method: "POST",
        body: JSON.stringify({ imageDataUrl }),
      });
      setSetup(res);
      setNotice({ tone: "ready", text: "תמונת הרפרנס עודכנה בהצלחה!" });
    } catch (err) {
      console.error("Model reference upload error:", err);
      const msg = err?.message || "";
      const isPatternError = msg.includes("pattern") || msg.includes("מחרוזת");
      if (isPatternError) {
        setError("מערכת ההפעלה של הנייד חסמה את הפורמט של התמונה. מומלץ לבחור תמונה רגילה מהגלריה (JPG/PNG).");
      } else {
        setError(msg || "שגיאה בהעלאת תמונת הרפרנס");
      }
    } finally {
      setUploadingModel(false);
    }
  };

  useEffect(() => {
    api(CONFIG_API).then(setSetup).catch((requestError) => setSetup({ ready: false, error: requestError.message }));
    api(API)
      .then((storedJobs) => {
        const visibleJobs = storedJobs.filter((job) => job.status !== "complete" && job.stages?.crop?.status !== "rejected" && job.stages?.garment?.status !== "rejected" && job.stages?.modeled?.status !== "rejected");
        setJobs(visibleJobs);
        setDrafts(Object.fromEntries(visibleJobs.map((job) => [job.id, defaultDraft(job)])));
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async (id) => {
    try {
      const next = await api(`${API}/${id}`);
      setJobs((current) => current.map((job) => job.id === id ? next : job));
      setDrafts((current) => current[id] ? current : { ...current, [id]: defaultDraft(next) });
    } catch (requestError) { setError(requestError.message); }
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => (job.stages?.crop?.status === "approved" && ["processing", "pending", "queued"].includes(job.stages?.garment?.status)) || ["processing", "queued"].includes(job.stages?.modeled?.status) || (job.stages?.garment?.status === "approved" && job.stages?.modeled?.status === "pending"))) return undefined;
    const timer = setInterval(() => jobs.forEach((job) => refresh(job.id)), 900);
    return () => clearInterval(timer);
  }, [jobs, refresh]);

  const submitFiles = useCallback(async (files) => {
    if (!setup?.ready) { setOpen(true); return; }
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setDragging(false); setError(""); setNotice(null);
    for (const file of images) {
      try {
        // Phone photos can exceed the hosted request size limit, so downscale first
        const imageDataUrl = await compressImageForUpload(file, 1600, 0.9);
        const result = await api(API, { method: "POST", body: JSON.stringify({ imageDataUrl, metadata: { name: file.name.replace(/\.[^.]+$/, "") } }) });
        const createdJobs = result.jobs || [result];
        if (!createdJobs.length && result.noClothingDetected) {
          setNotice({ tone: "complete", text: "No clothing detected", detail: `We couldn’t find a distinct wearable item in ${file.name}. Try a clearer or more tightly framed image.` });
          setOpen(true);
          continue;
        }
        setJobs((current) => [...current, ...createdJobs]);
        setDrafts((current) => ({ ...current, ...Object.fromEntries(createdJobs.map((job) => [job.id, defaultDraft(job)])) }));
      } catch (requestError) { setError(requestError.message); }
    }
  }, [setup]);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragging(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragging(false); submitFiles(event.dataTransfer.files); };
    const onPaste = (event) => { const files = [...event.clipboardData.files]; if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); submitFiles(files); } };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [submitFiles]);

  const perform = async (job, stage, action, prompt = "") => {
    setBusyId(job.id); setError("");
    try {
      if (stage === "garment" && action === "approve") {
        const draft = drafts[job.id];
        const metadata = { ...draft, secondaryColor: draft.secondaryColor || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
        await api(`${API}/${job.id}/metadata`, { method: "PATCH", body: JSON.stringify({ metadata }) });
        const updated = await api(`${API}/${job.id}/stages/garment/approve`, { method: "POST" });
        const garmentPath = `/api/import/library/import-${job.id}-garment.png`;
        onGarmentApproved?.({ id: `import-${job.id}`, ...metadata, image: garmentPath, thumbnail: garmentPath, modeledImage: null, palette: [metadata.color, metadata.secondaryColor].filter(Boolean), importJobId: job.id });
        setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      } else {
        const updated = await api(`${API}/${job.id}/stages/${stage}/${action}`, { method: "POST", body: action === "regenerate" ? JSON.stringify({ prompt }) : undefined });
        const removeFromQueue = action === "reject" || (stage === "modeled" && action === "approve");
        const remainingJobs = removeFromQueue ? jobs.filter((item) => item.id !== job.id) : null;
        setJobs((current) => removeFromQueue ? current.filter((item) => item.id !== job.id) : current.map((item) => item.id === job.id ? updated : item));
        if (removeFromQueue) {
          setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
          setSelectedReviewId(null);
          if (!remainingJobs.length) setOpen(false);
        }
        if (action === "regenerate") setRegenerationPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" }));
        if (stage === "modeled" && action === "approve") onModeledApproved?.(job.id, `/api/import/library/import-${job.id}-modeled.png`);
      }
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const performCleanup = async (job, action, requestedTolerance) => {
    setBusyId(job.id); setError("");
    try {
      const tolerance = requestedTolerance ?? cleanupTolerances[job.id] ?? job.stages?.garment?.cleanupTolerance ?? 46;
      const updated = await api(`${API}/${job.id}/stages/garment/cleanup-${action}`, { method: "POST", body: JSON.stringify({ tolerance }) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setCleanupTolerances((current) => ({ ...current, [job.id]: updated.stages?.garment?.cleanupTolerance ?? tolerance }));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const deleteJob = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await api(`${API}/${job.id}`, { method: "DELETE" });
      const remaining = jobs.filter((item) => item.id !== job.id);
      setJobs(remaining);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
      if (selectedReviewId === job.id) setSelectedReviewId(null);
      if (!remaining.length) setOpen(false);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const active = jobs[jobs.length - 1];
  const setupRequired = setup?.ready === false;
  const activeStatus = setupRequired ? { tone: "error", text: "Setup required" } : active ? deriveStatus(active) : notice;
  const readyCount = jobs.filter((job) => deriveStatus(job).tone === "ready").length;
  const selectedReviewJob = jobs.find((job) => job.id === selectedReviewId && (reviewStageFor(job) || hasCleanupFailure(job)));
  const reviewJob = selectedReviewJob || jobs.find((job) => reviewStageFor(job)) || jobs.find((job) => hasCleanupFailure(job)) || active;
  const reviewStage = reviewJob ? reviewStageFor(reviewJob) : null;
  const progress = 0;
  const hasImportActivity = Boolean(jobs.length || notice || setupRequired);

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden disabled={!setup?.ready} onChange={(event) => { submitFiles(event.target.files); event.target.value = ""; }} />
      <input ref={modelInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/jpg,image/heic,image/heif,image/*" hidden onChange={(event) => { uploadModelReference(event.target.files[0]); event.target.value = ""; }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}>
        <div className="import-drop-target is-over">
          <UploadSimple size={34} weight="light" />
          <h2>גררו לכאן תמונות של בגדים</h2>
          <p>ניתן להעלות פריט בודד או צילום של אאוטפיט שלם. הבגדים יישמרו ישירות במלתחה.</p>
        </div>
      </div>
      {visible && !hidden && (
        <button
          className={`import-tray${hasImportActivity ? " is-expanded" : ""}`}
          type="button"
          onClick={() => setupRequired || hasImportActivity ? setOpen(true) : inputRef.current?.click()}
          aria-label={setupRequired ? "הוראות הגדרה" : hasImportActivity ? "התקדמות ייבוא" : "הוספת בגדים"}
        >
          <span className="import-tray__icon">
            {activeStatus?.tone === "processing" ? <SpinnerGap size={19} className="import-spinner" /> : activeStatus?.tone === "error" ? <WarningCircle size={19} /> : readyCount ? <span className="import-count-badge">{readyCount}</span> : notice ? <X size={18} /> : <Plus size={19} />}
          </span>
          <span className="import-tray__label">{activeStatus?.text || "הוספת בגדים"}</span>
          {active && <img className="import-tray__preview" src={active.stages?.garment?.assetUrl || active.stages?.garment?.failedAssetUrl || active.stages?.crop?.assetUrl || active.originalAssetUrl} alt="" />}
        </button>
      )}
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header className="import-popover__header">
            <div>
              <p className="import-popover__eyebrow">ייבוא למלתחה</p>
              <h2 className="import-popover__title" id="import-title">
                {readyCount ? `${readyCount} מוכנים לבדיקה` : activeStatus?.tone === "error" ? "דרושה התייחסות" : jobs.length ? "מעבד פריטים חדשים..." : notice?.text || "הוספה למלתחה"}
              </h2>
            </div>
            <button className="import-icon-button" type="button" onClick={() => setOpen(false)} aria-label="סגור"><X size={20} /></button>
          </header>
          {!jobs.length ? setupRequired ? (
            <div className="import-drop-target import-setup-warning">
              <WarningCircle size={30} />
              <h2>דרושה תמונת מודל</h2>
              {!setup.hasModelReference && (
                <p style={{ margin: "6px 0", fontSize: "14px" }}>
                  👤 <strong>תמונת מודל:</strong> העלו תמונת מודל דרך הכפתור בראש העמוד להלבשת בגדים עלייך.
                </p>
              )}
            </div>
          ) : (
            <div className="import-drop-target">
              <UploadSimple size={28} />
              <h2>{notice ? "נסו תמונה אחרת" : "העלאת תמונות של בגדים"}</h2>
              <p>{notice?.detail || "גררו לכאן תמונות של בגדים, או לחצו על הכפתור לבחירת קבצים."}</p>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center", marginTop: "14px" }}>
                <button className="import-button import-button--primary" onClick={() => { setNotice(null); inputRef.current?.click(); }}>
                  <Plus size={16} weight="bold" /> בחירת תמונות בגדים
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={`import-progress${activeStatus?.tone !== "processing" ? " is-reviewing" : progress < 100 ? " is-indeterminate" : ""}`}>
                <div className="import-progress__meta">
                  <span>{activeStatus?.text}</span>
                  <span>{jobs.length} פריטים</span>
                </div>
                {activeStatus?.tone === "processing" && <div className="import-progress__track"><div className="import-progress__bar" style={{ "--import-progress": `${progress}%` }} /></div>}
              </div>
              {reviewJob && reviewStage ? <ReviewEditor job={reviewJob} stage={reviewStage} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))} regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))} busy={busyId === reviewJob.id} onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)} /> : reviewJob && hasCleanupFailure(reviewJob) ? <CleanupEditor job={reviewJob} tolerance={cleanupTolerances[reviewJob.id] ?? reviewJob.stages.garment.cleanupTolerance ?? 46} setTolerance={(tolerance) => setCleanupTolerances((current) => ({ ...current, [reviewJob.id]: tolerance }))} busy={busyId === reviewJob.id} onPreview={(tolerance) => performCleanup(reviewJob, "preview", tolerance)} onAccept={() => performCleanup(reviewJob, "accept")} /> : null}
              <div className="import-card-list">
                {jobs.map((job) => {
                  const status = deriveStatus(job);
                  const itemName = drafts[job.id]?.name || job.metadata?.name || "פריט חדש";
                  const failedStage = job.stages?.garment?.status === "failed" ? "garment" : job.stages?.modeled?.status === "failed" ? "modeled" : null;
                  return (
                    <article className={`import-card is-${status.tone}${reviewJob?.id === job.id ? " is-selected" : ""}`} key={job.id}>
                      <img className="import-card__image" src={job.stages?.garment?.assetUrl || job.stages?.garment?.failedAssetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl} alt="" />
                      <div className="import-card__body">
                        <h3 className="import-card__title">{itemName}</h3>
                        <p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p>
                      </div>
                      <div className="import-card__actions">
                        {status.tone === "ready" && <button className="import-icon-button" onClick={() => { setSelectedReviewId(job.id); setOpen(true); }} aria-label={`בדיקת ${itemName}`}><Check size={17} /></button>}
                        {failedStage && <button className="import-button import-card__retry" disabled={busyId === job.id} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> ניסיון חוזר</button>}
                        <button className="import-icon-button import-card__delete" disabled={busyId === job.id} onClick={() => deleteJob(job)} aria-label={`מחק ${itemName}`}><Trash size={16} /></button>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="import-actions">
                <button className="import-button" onClick={() => inputRef.current?.click()}><Plus size={14} /> הוסף עוד</button>
              </div>
            </>
          )}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}
