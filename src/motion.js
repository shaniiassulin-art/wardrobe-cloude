import gsap from "gsap";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

// All motion in one place. Everything is skipped for people who asked their
// device to reduce motion, and hover effects only run with a real mouse.

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const OVERLAYS = ".viewer-overlay, .builder-modal-overlay, .import-popover-backdrop, .lightbox";

// Smooth page scrolling on computers. Phones already scroll smoothly, so they
// keep native scrolling. Open windows keep their own native scrolling.
export function startSmoothScroll() {
  if (reducedMotion() || !finePointer()) return () => {};
  const lenis = new Lenis({
    autoRaf: true,
    lerp: 0.12,
    prevent: (node) => Boolean(node?.closest?.(OVERLAYS)),
  });
  return () => lenis.destroy();
}

// Cards rise into place one after another
export function revealChildren(containers) {
  if (reducedMotion()) return;
  for (const container of containers) {
    if (!container?.children.length) continue;
    gsap.fromTo(
      container.children,
      { y: 26, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.6, ease: "power3.out", stagger: 0.045, clearProps: "transform,opacity" },
    );
  }
}

// Gentle 3D tilt that follows the mouse over a card
export function tiltHandlers() {
  if (reducedMotion() || !finePointer()) return {};
  return {
    onPointerMove(event) {
      const card = event.currentTarget;
      const box = card.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      gsap.to(card, { rotateY: x * 10, rotateX: -y * 10, y: -6, transformPerspective: 700, duration: 0.4, ease: "power2.out", overwrite: "auto" });
    },
    onPointerLeave(event) {
      gsap.to(event.currentTarget, { rotateY: 0, rotateX: 0, y: 0, duration: 0.7, ease: "elastic.out(1, 0.6)", overwrite: "auto" });
    },
  };
}

// Windows (item view, dialogs, full-screen images) open with a soft motion
export function watchOverlays() {
  if (reducedMotion()) return () => {};
  const animate = (element) => {
    if (element.matches(".item-sheet")) {
      gsap.from(element, { x: -36, opacity: 0, duration: 0.5, ease: "power3.out", clearProps: "transform,opacity" });
      gsap.from(element.children, { y: 14, opacity: 0, duration: 0.45, ease: "power2.out", stagger: 0.05, delay: 0.08, clearProps: "transform,opacity" });
    } else if (element.matches(".builder-modal")) {
      gsap.from(element, { y: 18, scale: 0.97, opacity: 0, duration: 0.45, ease: "power3.out", clearProps: "transform,opacity" });
    } else if (element.matches(".lightbox__image")) {
      gsap.from(element, { scale: 0.92, opacity: 0, duration: 0.35, ease: "power2.out", clearProps: "transform,opacity" });
    }
  };
  const selector = ".item-sheet, .builder-modal, .lightbox__image";
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(selector)) animate(node);
        node.querySelectorAll(selector).forEach(animate);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

// Words fade in from a soft blur, one after another
export function revealWords(words) {
  if (reducedMotion() || !words?.length) return;
  gsap.fromTo(
    words,
    { opacity: 0, y: 14, filter: "blur(8px)" },
    { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.8, ease: "power3.out", stagger: 0.09, clearProps: "transform,opacity,filter" },
  );
}
