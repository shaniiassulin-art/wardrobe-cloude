// Saves a piece of a photo: a new entry for the first piece of a photo, then added
// to the same entry. Shared by the inspiration window and the add window.
export async function saveWishlistPiece({ wardrobeId, entryId, imageDataUrl, piece }) {
  const fields = { name: piece.name, part: piece.part, color: piece.color, colorName: piece.colorName, description: piece.description, box: piece.box };
  const res = await fetch(entryId ? `/api/import/wishlist/${entryId}/pieces` : "/api/import/wishlist", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wardrobe-id": wardrobeId },
    body: JSON.stringify(entryId ? { piece: fields } : { piece: fields, imageDataUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "לא ניתן להוסיף ל-Wishlist כרגע");
  return data;
}

