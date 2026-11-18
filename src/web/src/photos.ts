/**
 * Shrinks a photo on the phone before it's queued: at most 1600 px on the long side, JPEG ~75%.
 * A 4 MB phone photo becomes ~250 KB, which matters on weak cellular and keeps storage costs near zero.
 */
export async function compressPhoto(file: File): Promise<Blob> {
  const MAX = 1600;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Format the browser can't decode (rare). Send it as-is if it's already a reasonable JPEG/PNG.
    if (/^image\/(jpeg|png)$/.test(file.type) && file.size < 5_000_000) return file;
    throw new Error('This photo format is not supported. Try a screenshot or a regular camera photo.');
  }
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the photo.'))), 'image/jpeg', 0.75));
}
