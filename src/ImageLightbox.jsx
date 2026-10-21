import { useCallback, useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, MagnifyingGlassMinus, MagnifyingGlassPlus, X } from "@phosphor-icons/react";

const MAX_SCALE = 6;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Full-screen view of an image, or of a set of images with previous/next.
// Pinch with two fingers to zoom in and out (the rest of the site never zooms),
// drag with one finger to look around, double-tap to zoom in or back out, swipe
// sideways to move between images. On a computer: click, the magnifier, or a
// trackpad pinch. Closes on Escape, the close button, or a click outside the image.
export function ImageLightbox({ src, alt = "", images, startIndex = 0, onClose }) {
  const list = images?.length ? images : (src ? [{ src, alt }] : []);
  const [index, setIndex] = useState(() => Math.min(Math.max(0, startIndex), Math.max(0, list.length - 1)));
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [moving, setMoving] = useState(false);
  const closeRef = useRef(null);
  const frameRef = useRef(null);
  const imageRef = useRef(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const current = list[index];
  const many = list.length > 1;
  const zoomed = view.scale > 1.01;

  // Keeps the zoomed image covering its own place, so it never drifts off
  const settle = useCallback((next) => {
    const image = imageRef.current;
    if (!image || next.scale <= 1.01) return { scale: 1, x: 0, y: 0 };
    const w = image.offsetWidth;
    const h = image.offsetHeight;
    return { scale: next.scale, x: clamp(next.x, w * (1 - next.scale), 0), y: clamp(next.y, h * (1 - next.scale), 0) };
  }, []);

  // A point on the screen, in the image's own (unzoomed) coordinates
  const local = (clientX, clientY) => {
    const image = imageRef.current;
    const frame = frameRef.current;
    const box = frame.getBoundingClientRect();
    return { x: clientX - box.left - image.offsetLeft, y: clientY - box.top - image.offsetTop };
  };

  // Zoom to `scale` keeping the spot under (clientX, clientY) in place
  const zoomAt = useCallback((scale, clientX, clientY) => {
    const image = imageRef.current;
    if (!image) return;
    const from = viewRef.current;
    const point = clientX === undefined
      ? { x: image.offsetWidth / 2, y: image.offsetHeight / 2 }
      : local(clientX, clientY);
    const target = clamp(scale, 1, MAX_SCALE);
    const ratio = target / from.scale;
    setView(settle({ scale: target, x: point.x - (point.x - from.x) * ratio, y: point.y - (point.y - from.y) * ratio }));
  }, [settle]);

  const go = useCallback((step) => {
    if (!many) return;
    setView({ scale: 1, x: 0, y: 0 });
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

  // Touch: pinch, drag, double-tap and swipe. Listeners are not passive so the
  // browser does not scroll or zoom the page underneath.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    let gesture = null;
    let lastTap = 0;
    const distance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const middle = (a, b) => ({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });

    const onStart = (event) => {
      if (event.target.closest("button")) return;
      const from = viewRef.current;
      if (event.touches.length === 2) {
        const [a, b] = event.touches;
        const mid = middle(a, b);
        const point = local(mid.clientX, mid.clientY);
        gesture = { type: "pinch", d0: distance(a, b), s0: from.scale, ix: (point.x - from.x) / from.scale, iy: (point.y - from.y) / from.scale };
        setMoving(true);
      } else if (event.touches.length === 1) {
        const t = event.touches[0];
        gesture = { type: "pan", sx: t.clientX, sy: t.clientY, x0: from.x, y0: from.y, moved: false, at: Date.now() };
      }
      event.preventDefault();
    };
    const onMove = (event) => {
      if (!gesture) return;
      event.preventDefault();
      if (gesture.type === "pinch" && event.touches.length >= 2) {
        const [a, b] = event.touches;
        const mid = middle(a, b);
        const point = local(mid.clientX, mid.clientY);
        const scale = clamp(gesture.s0 * (distance(a, b) / gesture.d0), 0.85, MAX_SCALE);
        setView({ scale, x: point.x - gesture.ix * scale, y: point.y - gesture.iy * scale });
      } else if (gesture.type === "pan" && event.touches.length === 1) {
        const t = event.touches[0];
        const dx = t.clientX - gesture.sx;
        const dy = t.clientY - gesture.sy;
        if (Math.abs(dx) + Math.abs(dy) > 8) gesture.moved = true;
        if (viewRef.current.scale > 1.01) {
          setMoving(true);
          setView(settle({ scale: viewRef.current.scale, x: gesture.x0 + dx, y: gesture.y0 + dy }));
        } else {
          gesture.dx = dx;
          gesture.dy = dy;
        }
      }
    };
    const onEnd = (event) => {
      if (!gesture) return;
      if (event.touches.length > 0) {
        // One finger lifted during a pinch: carry on as a drag with the other
        const t = event.touches[0];
        const from = viewRef.current;
        gesture = { type: "pan", sx: t.clientX, sy: t.clientY, x0: from.x, y0: from.y, moved: true, at: 0 };
        return;
      }
      const ended = gesture;
      gesture = null;
      setMoving(false);
      // Back within bounds (a pinch that went below the normal size springs back)
      setView((value) => settle(value));
      if (ended.type === "pinch") return;
      if (!ended.moved) {
        // Double-tap: zoom in at the spot, or back out
        const now = Date.now();
        const touch = event.changedTouches[0];
        if (now - lastTap < 300) {
          lastTap = 0;
          if (viewRef.current.scale > 1.01) setView({ scale: 1, x: 0, y: 0 });
          else zoomAt(2.5, touch.clientX, touch.clientY);
        } else {
          lastTap = now;
          // A single tap outside the image closes, like a click
          if (event.target === frame && viewRef.current.scale <= 1.01) setTimeout(() => { if (lastTap === now) onClose(); }, 300);
        }
        return;
      }
      // Swipe sideways between images when not zoomed
      if (viewRef.current.scale <= 1.01 && Math.abs(ended.dx || 0) > 60 && Math.abs(ended.dx) > Math.abs(ended.dy || 0) * 1.5) {
        go(ended.dx < 0 ? 1 : -1);
      }
    };
    // Trackpad pinch on a computer (sent as a wheel event with Ctrl)
    const onWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomAt(viewRef.current.scale * Math.exp(-event.deltaY / 100), event.clientX, event.clientY);
    };
    frame.addEventListener("touchstart", onStart, { passive: false });
    frame.addEventListener("touchmove", onMove, { passive: false });
    frame.addEventListener("touchend", onEnd, { passive: false });
    frame.addEventListener("touchcancel", onEnd, { passive: false });
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      frame.removeEventListener("touchstart", onStart);
      frame.removeEventListener("touchmove", onMove);
      frame.removeEventListener("touchend", onEnd);
      frame.removeEventListener("touchcancel", onEnd);
      frame.removeEventListener("wheel", onWheel);
    };
  }, [settle, zoomAt, go, onClose, index]);

  // Mouse: click to zoom in at the spot or back out, drag to look around
  const mouse = useRef(null);
  const onMouseDown = (event) => {
    if (event.button !== 0) return;
    const from = viewRef.current;
    mouse.current = { sx: event.clientX, sy: event.clientY, x0: from.x, y0: from.y, moved: false };
  };
  const onMouseMove = (event) => {
    const drag = mouse.current;
    if (!drag || viewRef.current.scale <= 1.01) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; setMoving(true); }
    setView(settle({ scale: viewRef.current.scale, x: drag.x0 + dx, y: drag.y0 + dy }));
  };
  const onMouseUp = (event) => {
    const drag = mouse.current;
    mouse.current = null;
    setMoving(false);
    if (!drag || drag.moved) return;
    if (viewRef.current.scale > 1.01) setView({ scale: 1, x: 0, y: 0 });
    else zoomAt(2.5, event.clientX, event.clientY);
  };

  if (!current) return null;
  return (
    <div className={`lightbox${zoomed ? " is-zoomed" : ""}`} role="dialog" aria-modal="true" aria-label={current.alt || "תמונה בגודל מלא"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="lightbox__frame" ref={frameRef} onMouseDown={(event) => !zoomed && event.target === event.currentTarget && onClose()}>
        <img
          key={current.src}
          ref={imageRef}
          className={`lightbox__image${moving ? " is-moving" : ""}`}
          src={current.src}
          alt={current.alt || ""}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => { mouse.current = null; setMoving(false); }}
          draggable={false}
        />
      </div>
      <div className="lightbox__bar">
        <button ref={closeRef} className="lightbox__button" type="button" onClick={onClose} aria-label="סגירה"><X size={20} /></button>
        <button className="lightbox__button" type="button" onClick={() => (zoomed ? setView({ scale: 1, x: 0, y: 0 }) : zoomAt(2.5))} aria-label={zoomed ? "הקטנה" : "הגדלה"}>
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
