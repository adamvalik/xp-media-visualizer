/**
 * Picks the most vivid colour from album art. Pixels are weighted by
 * saturation and brightness so dark or grey covers still give a usable
 * accent. Resolves null if the image can't be read (e.g. no CORS).
 */
export async function albumColor(url: string): Promise<[number, number, number] | null> {
  if (!url) return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  try {
    await img.decode();
    const size = 24;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    let r = 0, g = 0, b = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const pr = data[i] / 255, pg = data[i + 1] / 255, pb = data[i + 2] / 255;
      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const weight = saturation * saturation * max + 0.002;
      r += pr * weight;
      g += pg * weight;
      b += pb * weight;
      total += weight;
    }
    r /= total;
    g /= total;
    b /= total;

    // Normalise so the brightest channel is 1: we want the hue, not the darkness.
    const peak = Math.max(r, g, b, 1e-3);
    return [r / peak, g / peak, b / peak];
  } catch {
    return null;
  }
}
