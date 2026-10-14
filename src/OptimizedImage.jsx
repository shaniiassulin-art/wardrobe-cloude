import { forwardRef } from "react";
import { Image } from "@unpic/react";

const IPX_OPTIONS = { ipx: { baseURL: "/_ipx" } };
const DEFAULT_BREAKPOINTS = [160, 240, 320, 480, 640, 800, 960, 1280];
// Widths the server can make small WebP copies at (see imageVariant in the server)
const SERVER_WIDTHS = [160, 240, 320, 480, 640, 800, 1080];

function sourcePath(src) {
  if (!src || typeof src !== "string") return src;
  return src.split(/[?#]/, 1)[0];
}

// Wardrobe and look photos are stored as large PNGs. The server can return a
// resized WebP copy instead, which is many times smaller.
export function canResize(src) {
  const path = sourcePath(src);
  return typeof path === "string" && (path.startsWith("/api/import/library/") || path.startsWith("/api/import/outfits/images/"));
}

export function resizedUrl(src, width) {
  if (!canResize(src)) return src;
  return `${src}${src.includes("?") ? "&" : "?"}w=${width}`;
}

export function resizedSrcSet(src, breakpoints = SERVER_WIDTHS) {
  const widths = [...new Set(breakpoints.map((width) => SERVER_WIDTHS.find((allowed) => allowed >= width) || SERVER_WIDTHS[SERVER_WIDTHS.length - 1]))];
  return widths.map((width) => `${resizedUrl(src, width)} ${width}w`).join(", ");
}

export const OptimizedImage = forwardRef(function OptimizedImage({
  src,
  alt = "",
  sizes = "100vw",
  breakpoints = DEFAULT_BREAKPOINTS,
  quality = 80,
  priority = false,
  loading,
  decoding,
  ...props
}, ref) {
  const normalizedSource = sourcePath(src);

  if (canResize(src)) {
    const widths = breakpoints.filter((width) => width <= 1080);
    return (
      <img
        ref={ref}
        src={resizedUrl(src, widths[Math.min(2, widths.length - 1)] || 480)}
        srcSet={resizedSrcSet(src, widths.length ? widths : SERVER_WIDTHS)}
        sizes={sizes}
        alt={alt}
        loading={loading || (priority ? "eager" : "lazy")}
        decoding={decoding || "async"}
        fetchPriority={priority ? "high" : undefined}
        {...props}
      />
    );
  }

  // The /_ipx resizer only exists on the local dev server
  if (import.meta.env.PROD || !normalizedSource || normalizedSource.startsWith("data:") || normalizedSource.startsWith("blob:") || normalizedSource.startsWith("/api/")) {
    return <img ref={ref} src={src} alt={alt} sizes={sizes} loading={loading || (priority ? "eager" : "lazy")} decoding={decoding || "async"} {...props} />;
  }

  return (
    <Image
      ref={ref}
      src={normalizedSource}
      alt={alt}
      fallback="ipx"
      options={IPX_OPTIONS}
      operations={{ ipx: { quality } }}
      layout="fullWidth"
      unstyled
      sizes={sizes}
      breakpoints={breakpoints}
      priority={priority}
      loading={loading}
      decoding={decoding}
      {...props}
    />
  );
});
