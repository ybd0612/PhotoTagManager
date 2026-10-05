import type { AiMaskStroke } from './types';

/** Paint a circular or elliptical brush along a stroke into a normalized float mask. */
export function paintMaskStroke(mask: Float32Array, width: number, height: number, stroke: AiMaskStroke): void {
  const radiusX = Math.max(1, stroke.radius);
  const radiusY = Math.max(1, stroke.radiusY ?? stroke.radius);
  const value = stroke.mode === 'restore' ? 1 : 0;
  for (let index = 0; index < stroke.points.length; index++) {
    const point = stroke.points[index];
    const previous = stroke.points[index - 1] ?? point;
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, Math.min(radiusX, radiusY) / 3)));
    for (let step = 0; step <= steps; step++) {
      const cx = previous.x + (dx * step) / steps;
      const cy = previous.y + (dy * step) / steps;
      const left = Math.max(0, Math.floor(cx - radiusX));
      const right = Math.min(width - 1, Math.ceil(cx + radiusX));
      const top = Math.max(0, Math.floor(cy - radiusY));
      const bottom = Math.min(height - 1, Math.ceil(cy + radiusY));
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const ox = x + 0.5 - cx;
          const oy = y + 0.5 - cy;
          if ((ox * ox) / (radiusX * radiusX) + (oy * oy) / (radiusY * radiusY) <= 1) mask[y * width + x] = value;
        }
      }
    }
  }
}
