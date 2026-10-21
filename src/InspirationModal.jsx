import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, Check, Heart, ImageSquare, MagicWand, X } from "@phosphor-icons/react";
import { fileToUploadDataUrl, fittedImage, imageFallback, thumbUrl } from "./image-files.js";
import { PRICES } from "./prices.js";

// Upload an inspiration photo (Pinterest, a screenshot...) and get the closest
// pieces from the wardrobe for each piece in it, then build the look from them.
// Same grouping as the server: a piece is only ever swapped for one of the same category
const groupOf = (part) => ({ upperbody: "top", top: "top", wholebody_up: "jacket", outerwear: "jacket", jacket: "jacket", lowerbody: "bottom", bottom: "bottom", dress: "dress", wholebody: "dress", shoes: "shoes", accessories_up: "accessory", accessory: "accessory" }[part] || part);

export function InspirationModal({ items, wardrobeId, onClose, onCreateLook, onWishlistAdded }) {
  const [photo, setPhoto] = useState(null);
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Wishlist state per piece of the photo: "saving" or "saved"
  const [wished, setWished] = useState({});
  const fileRef = useRef(null);
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  // Rows opened with "אחר": every other piece of the same category
  const [otherOpen, setOtherOpen] = useState({});
  const othersFor = (piece) => {
    const shown = new Set(piece.options.map((option) => option.id));
    return items.filter((item) => groupOf(item.part) === groupOf(piece.part) && !shown.has(item.id)).map((item) => ({ id: item.id, reason: "" }));
  };

  const choose = async (file) => {
    if (!file || !(file.type?.startsWith("image/") || /\.(heic|heif)$/i.test(file.name || ""))) return;
    setError("");
    setResult(null);
    setSelected([]);
    setWished({});
    setOtherOpen({});
    try {
      setPhoto(await fileToUploadDataUrl(file, 1280, 0.86));
    } catch (err) {
      setError(err.message || "לא ניתן לפתוח את התמונה.");
    }
  };

  // A photo can also be pasted (copied from Pinterest)
  useEffect(() => {
    const onPaste = (event) => {
      const file = [...(event.clipboardData?.files || [])].find((entry) => entry.type.startsWith("image/"));
      if (file) { event.preventDefault(); choose(file); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const analyze = async () => {
    if (!photo) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/import/inspiration", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": wardrobeId },
        body: JSON.stringify({ imageDataUrl: photo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "לא ניתן לנתח את התמונה כרגע");
      setResult(data);
      setWished({});
      // The best match of every piece is picked to start with
      setSelected([...new Set(data.pieces.filter((piece) => piece.level === "match" || piece.level === "kind").map((piece) => piece.options[0]?.id).filter(Boolean))]);
    } catch (err) {
      setError(err.message || "לא ניתן לנתח את התמונה כרגע");
    } finally {
      setBusy(false);
    }
  };

  // One pick per piece of the photo: choosing another match replaces it
  const pick = (piece, id) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id);
      const others = [...piece.options, ...othersFor(piece)].map((match) => match.id).filter((entry) => entry !== id);
      return [...current.filter((entry) => !others.includes(entry)), id];
    });
  };

  // Saved only when she asks for it
  const addToWishlist = async (piece, index) => {
    setWished((current) => ({ ...current, [index]: "saving" }));
    setError("");
    try {
      const res = await fetch("/api/import/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": wardrobeId },
        body: JSON.stringify({ name: piece.name, part: piece.part, color: piece.color, colorName: piece.colorName, description: piece.description, box: piece.box, note: result?.summary || "", imageDataUrl: photo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "לא ניתן להוסיף ל-Wishlist כרגע");
      setWished((current) => ({ ...current, [index]: "saved" }));
      onWishlistAdded?.(data);
    } catch (err) {
      setWished((current) => ({ ...current, [index]: undefined }));
      setError(err.message);
    }
  };

  const tiles = (piece, list) => (
    <div className="inspo-matches">
      {list.map((match) => {
        const item = byId.get(match.id);
        if (!item) return null;
        const on = selected.includes(match.id);
        return (
          <button key={match.id} type="button" className={`lb-tile inspo-tile${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => pick(piece, match.id)}>
            <span className="lb-tile__img">
              <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 240)} onError={imageFallback(item.thumbnail || item.image)} loading="lazy" decoding="async" alt="" />
              <span className="lb-tile__check" aria-hidden="true">{on && <Check size={12} weight="bold" />}</span>
            </span>
            <span className="lb-tile__name">{item.name}</span>
            {match.reason && <small className="inspo-reason">{match.reason}</small>}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="builder-modal-overlay look-builder-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="builder-modal look-builder inspo" role="dialog" aria-modal="true" aria-labelledby="inspo-title">
        <header className="lb-header">
          <h2 id="inspo-title">השראה מתמונה</h2>
          <button className="lb-close" type="button" onClick={onClose} aria-label="סגירה"><X size={18} /></button>
        </header>

        <div className="lb-body">
          <section className="lb-section">
            <input ref={fileRef} type="file" accept="image/*,.heic,.heif" hidden onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }} />
            {photo ? (
              <div className={`inspo-photo${result ? " is-small" : ""}`}>
                <img src={photo} alt="תמונת ההשראה" />
                <button type="button" className="lb-link" disabled={busy} onClick={() => fileRef.current?.click()}>תמונה אחרת</button>
              </div>
            ) : (
              <button type="button" className="inspo-drop" onClick={() => fileRef.current?.click()}>
                <ImageSquare size={30} />
                <strong>העלאת תמונה של לוק</strong>
                <span>צילום מסך מפינטרסט, מאינסטגרם או מכל מקום. אפשר גם להדביק תמונה שהעתקת.</span>
              </button>
            )}
          </section>

          {result && (
            <section className="lb-section inspo-results">
              {result.summary && <p className="inspo-summary">{result.summary}</p>}
              {!result.pieces.length && <p className="lb-hint">לא זוהו בגדים בתמונה. נסי תמונה אחרת שבה רואים את הלוק בבירור.</p>}
              {result.pieces.map((piece, index) => (
                <div key={`${piece.name}-${index}`} className="inspo-piece">
                  <div className="inspo-piece__head">
                    {piece.color && <span className="inspo-dot" style={{ background: piece.color }} aria-hidden="true" />}
                    <h3>{piece.name}{piece.colorName && <small className="inspo-colorname"> · {piece.colorName}</small>}</h3>
                    {othersFor(piece).length > 0 && (
                      <button type="button" className={`inspo-other${otherOpen[index] ? " is-on" : ""}`} aria-expanded={Boolean(otherOpen[index])} onClick={() => setOtherOpen((current) => ({ ...current, [index]: !current[index] }))}>
                        אחר
                      </button>
                    )}
                  </div>
                  {piece.note && <p className="inspo-missing">{piece.note}</p>}
                  {piece.options.length > 0 && tiles(piece, piece.options)}
                  {otherOpen[index] && (
                    <>
                      <p className="inspo-alt-title">פריט אחר מאותה קטגוריה:</p>
                      {tiles(piece, othersFor(piece))}
                    </>
                  )}
                  {piece.level !== "match" && (
                    <>
                      <button type="button" className={`inspo-wish${wished[index] === "saved" ? " is-saved" : ""}`} disabled={Boolean(wished[index])} onClick={() => addToWishlist(piece, index)}>
                        <Heart size={14} weight={wished[index] === "saved" ? "fill" : "regular"} />
                        <span>{wished[index] === "saved" ? "נוסף ל-Wishlist" : wished[index] === "saving" ? "מכין תמונה של הפריט..." : "הוספה ל-Wishlist"}</span>
                        {!wished[index] && <small>{PRICES.catalogLow}</small>}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>

        <footer className="lb-footer">
          {error && <p className="lb-error" role="alert">{error}</p>}
          <div className="lb-footer__actions">
            <button className="lb-button is-ghost" type="button" disabled={busy} onClick={onClose}>ביטול</button>
            {result ? (
              <>
                <button className="lb-button" type="button" disabled={busy} onClick={analyze}>
                  {busy && <ArrowClockwise size={15} className="spin" />}
                  <span>{busy ? "מחפש..." : "שוב"}</span>
                  {!busy && <small>{PRICES.inspiration}</small>}
                </button>
                <button className="lb-button is-primary" type="button" disabled={busy || !selected.length} onClick={() => onCreateLook(selected)}>
                  <MagicWand size={15} />
                  <span>יצירת לוק{selected.length ? ` (${selected.length})` : ""}</span>
                </button>
              </>
            ) : (
              <button className="lb-button is-primary" type="button" disabled={!photo || busy} onClick={analyze}>
                {busy ? <ArrowClockwise size={15} className="spin" /> : <MagicWand size={15} />}
                <span>{busy ? "מחפש פריטים דומים..." : "מציאת פריטים דומים"}</span>
                {!busy && <small>{PRICES.inspiration}</small>}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
