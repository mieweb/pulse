/** A 9:16 video inside the available frame, leaving space for its metadata above it. */
export function fitExportPreview(width: number, height: number, metadataHeight: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(metadataHeight) ||
    width <= 0 ||
    metadataHeight < 0 ||
    height <= metadataHeight
  ) {
    return null;
  }
  const cardWidth = Math.min(width, ((height - metadataHeight) * 9) / 16);
  return { width: cardWidth, height: (cardWidth * 16) / 9 };
}
