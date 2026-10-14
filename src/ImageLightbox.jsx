import { useCallback, useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, MagnifyingGlassMinus, MagnifyingGlassPlus, X } from "@phosphor-icons/react";

// Full-screen view of an image, or of a set of images with previous/next.
// Tapping the image (or the magnifier) zooms in to twice the size; drag or
// scroll to look around, tap again to zoom out. Closes on Escape, the close
// button, or a click outside the image.
export function ImageLightbox({ src, alt = "", images, startIndex = 0, onClose }) {
  const list = images?.length ? images : (src ? [{ src, alt }] : []);
  const [index, setIndex] = useState(() => Math.min(Math.max(0, startIndex), Math.max(0, list.length - 1)));
  const [zoomed, setZoomed] = useState(false);
  const closeRef = useRef(null);
  const frameRef = useRef(null);
  const current = list[index];
  const many = list.length > 1;

  const go = useCallback((step) => {
    if (!many) return;
    setZoomed(false);
    setIndex((value) => (value + step + list.length) % list.length);
  }, [many, list.length]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      // In a right-to-left page the left arrow moves forward
      if (event.key === "ArrowLeft") { event.stopPropagation(); go(1); }
      if (event.key === "ArrowRight") { event.stopPropagation(); go(-1); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    closeRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, go]);

  // Zoom in around the spot that was tapped
  const toggleZoom = (event) => {
    const frame = frameRef.current;
    if (zoomed || !frame || !event) { setZoomed((value) => !value); return; }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    setZoomed(true);
    requestAnimationFrame(() => {
      frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) * x;
      frame.scrollTop = (frame.scrollHeight - frame.clientHeight) * y;
    });
  };

  if (!current) return null;
  return (
    <div className={`lightbox${zoomed ? " is-zoomed" : ""}`} role="dialog" aria-modal="true" aria-label={current.alt || "תמונה בגודל מלא"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="lightbox__frame" ref={frameRef} onMouseDown={(event) => !zoomed && event.target === event.currentTarget && onClose()}>
        <img
          key={current.src}
          className="lightbox__image"
          src={current.src}
          alt={current.alt || ""}
          onClick={toggleZoom}
          draggable={false}
        />
      </div>
      <div className="lightbox__bar">
        <button ref={closeRef} className="lightbox__button" type="button" onClick={onClose} aria-label="סגירה"><X size={20} /></button>
        <button className="lightbox__button" type="button" onClick={() => toggleZoom()} aria-label={zoomed ? "הקטנה" : "הגדלה"}>
          {zoomed ? <MagnifyingGlassMinus size={20} /> : <MagnifyingGlassPlus size={20} />}
        </button>
      </div>
      {(current.alt || many) && (
        <p className="lightbox__caption">{current.alt}{many && <span> · {index + 1} מתוך {list.length}</span>}</p>
      )}
      {many && (
        <>
          <button className="lightbox__nav is-prev" type="button" onClick={() => go(-1)} aria-label="התמונה הקודמת"><CaretRight size={22} /></button>
          <button className="lightbox__nav is-next" type="button" onClick={() => go(1)} aria-label="התמונה הבאה"><CaretLeft size={22} /></button>
        </>
      )}
    </div>
  );
}
