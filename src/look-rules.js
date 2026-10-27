// A dress (or a one-piece) is worn on its own: never with a top, trousers or a skirt
const isDressPart = (part) => part === "dress" || part === "wholebody";
const isSeparatePart = (part) => part === "upperbody" || part === "lowerbody";

export function clashesWithLook(item, look) {
  if (isDressPart(item.part)) return look.some((other) => isSeparatePart(other.part) || isDressPart(other.part));
  if (isSeparatePart(item.part)) return look.some((other) => isDressPart(other.part));
  return false;
}
