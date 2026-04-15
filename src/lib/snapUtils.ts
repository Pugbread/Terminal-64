import { SNAP_THRESHOLD } from "./constants";

export interface SnapGuide {
  orientation: "vertical" | "horizontal";
  position: number;
  start: number;
  end: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeDragSnap(
  dragging: Rect,
  others: Rect[],
  threshold = SNAP_THRESHOLD
): { x: number; y: number; guides: SnapGuide[] } {
  let snapX = dragging.x;
  let snapY = dragging.y;
  let bestDx = threshold + 1;
  let bestDy = threshold + 1;

  const dL = dragging.x;
  const dR = dragging.x + dragging.width;
  const dT = dragging.y;
  const dB = dragging.y + dragging.height;
  const dCx = dragging.x + dragging.width / 2;
  const dCy = dragging.y + dragging.height / 2;

  for (const o of others) {
    const oL = o.x;
    const oR = o.x + o.width;
    const oT = o.y;
    const oB = o.y + o.height;
    const oCx = o.x + o.width / 2;
    const oCy = o.y + o.height / 2;

    // X-axis snap candidates: [distance, resulting x]
    const xs: [number, number][] = [
      [Math.abs(dL - oL), oL],
      [Math.abs(dL - oR), oR],
      [Math.abs(dR - oL), oL - dragging.width],
      [Math.abs(dR - oR), oR - dragging.width],
      [Math.abs(dCx - oCx), oCx - dragging.width / 2],
    ];
    for (const [dist, nx] of xs) {
      if (dist < bestDx) { bestDx = dist; snapX = nx; }
    }

    // Y-axis snap candidates
    const ys: [number, number][] = [
      [Math.abs(dT - oT), oT],
      [Math.abs(dT - oB), oB],
      [Math.abs(dB - oT), oT - dragging.height],
      [Math.abs(dB - oB), oB - dragging.height],
      [Math.abs(dCy - oCy), oCy - dragging.height / 2],
    ];
    for (const [dist, ny] of ys) {
      if (dist < bestDy) { bestDy = dist; snapY = ny; }
    }
  }

  const didSnapX = bestDx <= threshold;
  const didSnapY = bestDy <= threshold;
  const finalX = didSnapX ? Math.round(snapX) : dragging.x;
  const finalY = didSnapY ? Math.round(snapY) : dragging.y;

  const guides = buildGuides(
    { x: finalX, y: finalY, width: dragging.width, height: dragging.height },
    others,
    didSnapX,
    didSnapY
  );

  return { x: finalX, y: finalY, guides };
}

export function computeResizeSnap(
  rect: Rect,
  edges: string,
  others: Rect[],
  threshold = SNAP_THRESHOLD
): { x: number; y: number; width: number; height: number; guides: SnapGuide[] } {
  let { x, y, width, height } = rect;
  const guides: SnapGuide[] = [];

  const vEdges: number[] = [];
  const hEdges: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  for (const o of others) {
    vEdges.push(o.x, o.x + o.width);
    hEdges.push(o.y, o.y + o.height);
    widths.push(o.width);
    heights.push(o.height);
  }

  const closest = (val: number, targets: number[]): number | null => {
    let best: number | null = null;
    let bestD = threshold + 1;
    for (const t of targets) {
      const d = Math.abs(val - t);
      if (d < bestD) { bestD = d; best = t; }
    }
    return bestD <= threshold ? best : null;
  };

  // Edge snapping
  if (edges.includes("e")) {
    const snap = closest(x + width, vEdges);
    if (snap !== null) {
      width = snap - x;
      guides.push(...verticalGuide(snap, { x, y, width, height }, others));
    }
  }

  if (edges.includes("w")) {
    const snap = closest(x, vEdges);
    if (snap !== null) {
      width += x - snap;
      x = snap;
      guides.push(...verticalGuide(snap, { x, y, width, height }, others));
    }
  }

  if (edges.includes("s")) {
    const snap = closest(y + height, hEdges);
    if (snap !== null) {
      height = snap - y;
      guides.push(...horizontalGuide(snap, { x, y, width, height }, others));
    }
  }

  if (edges.includes("n")) {
    const snap = closest(y, hEdges);
    if (snap !== null) {
      height += y - snap;
      y = snap;
      guides.push(...horizontalGuide(snap, { x, y, width, height }, others));
    }
  }

  // Size snapping — match other terminals' widths/heights
  if (edges.includes("e") || edges.includes("w")) {
    const snapW = closest(width, widths);
    if (snapW !== null) {
      if (edges.includes("w")) {
        x += width - snapW;
      }
      width = snapW;
      guides.push({ orientation: "horizontal", position: y + height, start: x, end: x + width });
    }
  }

  if (edges.includes("s") || edges.includes("n")) {
    const snapH = closest(height, heights);
    if (snapH !== null) {
      if (edges.includes("n")) {
        y += height - snapH;
      }
      height = snapH;
      guides.push({ orientation: "vertical", position: x + width, start: y, end: y + height });
    }
  }

  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), guides };
}

function buildGuides(snapped: Rect, others: Rect[], didX: boolean, didY: boolean): SnapGuide[] {
  const guides: SnapGuide[] = [];
  const sL = snapped.x;
  const sR = snapped.x + snapped.width;
  const sT = snapped.y;
  const sB = snapped.y + snapped.height;
  const sCx = snapped.x + snapped.width / 2;
  const sCy = snapped.y + snapped.height / 2;

  if (didX) {
    for (const o of others) {
      const oCx = o.x + o.width / 2;
      for (const edge of [sL, sR]) {
        for (const oEdge of [o.x, o.x + o.width]) {
          if (Math.abs(edge - oEdge) < 1) {
            guides.push({
              orientation: "vertical",
              position: edge,
              start: Math.min(sT, o.y),
              end: Math.max(sB, o.y + o.height),
            });
          }
        }
      }
      if (Math.abs(sCx - oCx) < 1) {
        guides.push({
          orientation: "vertical",
          position: sCx,
          start: Math.min(sT, o.y),
          end: Math.max(sB, o.y + o.height),
        });
      }
    }
  }

  if (didY) {
    for (const o of others) {
      const oCy = o.y + o.height / 2;
      for (const edge of [sT, sB]) {
        for (const oEdge of [o.y, o.y + o.height]) {
          if (Math.abs(edge - oEdge) < 1) {
            guides.push({
              orientation: "horizontal",
              position: edge,
              start: Math.min(sL, o.x),
              end: Math.max(sR, o.x + o.width),
            });
          }
        }
      }
      if (Math.abs(sCy - oCy) < 1) {
        guides.push({
          orientation: "horizontal",
          position: sCy,
          start: Math.min(sL, o.x),
          end: Math.max(sR, o.x + o.width),
        });
      }
    }
  }

  return guides;
}

function verticalGuide(pos: number, rect: Rect, others: Rect[]): SnapGuide[] {
  const matching = others.filter(o => Math.abs(o.x - pos) < 1 || Math.abs(o.x + o.width - pos) < 1);
  if (matching.length === 0) return [{ orientation: "vertical", position: pos, start: rect.y, end: rect.y + rect.height }];
  const minY = Math.min(rect.y, ...matching.map(o => o.y));
  const maxY = Math.max(rect.y + rect.height, ...matching.map(o => o.y + o.height));
  return [{ orientation: "vertical", position: pos, start: minY, end: maxY }];
}

function horizontalGuide(pos: number, rect: Rect, others: Rect[]): SnapGuide[] {
  const matching = others.filter(o => Math.abs(o.y - pos) < 1 || Math.abs(o.y + o.height - pos) < 1);
  if (matching.length === 0) return [{ orientation: "horizontal", position: pos, start: rect.x, end: rect.x + rect.width }];
  const minX = Math.min(rect.x, ...matching.map(o => o.x));
  const maxX = Math.max(rect.x + rect.width, ...matching.map(o => o.x + o.width));
  return [{ orientation: "horizontal", position: pos, start: minX, end: maxX }];
}
