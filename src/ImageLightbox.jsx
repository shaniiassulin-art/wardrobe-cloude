import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";

// Full-screen view of a single image. Closes on Escape, the close button, or a
// click outside the image. Transparent cutouts sit on a light checkerboard.
export function ImageLightbox({ src, alt = "", onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKeyDown, true);
    closeRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  if (!src) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt || "תמונה בגודל מלא"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <button ref={closeRef} className="lightbox__close" type="button" onClick={onClose} aria-label="סגירה">
        <X size={22} />
      </button>
      <img className="lightbox__image" src={src} alt={alt} />
    </div>
  );
}
