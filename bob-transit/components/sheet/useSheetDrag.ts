"use client";

/**
 * Drag-to-resize behaviour for the bottom sheet.
 *
 * All of the decision-making lives in `components/lib/detents.ts` (pure, tested).
 * This hook only translates pointer events into `{dyPx, velocity}` and applies
 * the result — so the snapping logic that ships is exactly the logic the tests
 * exercise.
 *
 * No hover is involved anywhere: the sheet responds to pointerdown/move/up and
 * to keyboard, and every affordance is a real, always-visible control.
 */
import { useCallback, useRef, useState } from "react";

import {
  detentHeightPx,
  dragHeightPx,
  resolveDragRelease,
  stepDetent,
  type DetentName,
} from "@/components/lib/detents";

/** Movement under this many px, released quickly, counts as a tap. */
const TAP_SLOP_PX = 8;
/** Tap must be released within this many ms. */
const TAP_MAX_MS = 300;

export interface SheetDragHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export interface UseSheetDragResult {
  detent: DetentName;
  setDetent: (detent: DetentName) => void;
  /** Height the sheet should render at right now (drag height while dragging). */
  heightPx: number;
  isDragging: boolean;
  dragHandlers: SheetDragHandlers;
  /** True while the sheet is settling, so the component can apply the transition. */
  isSettling: boolean;
}

export function useSheetDrag(
  viewportHeight: number,
  initialDetent: DetentName = "peek",
): UseSheetDragResult {
  const [detent, setDetentState] = useState<DetentName>(initialDetent);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const startRef = useRef<{
    y: number;
    time: number;
    detent: DetentName;
    pointerId: number;
  } | null>(null);
  const movedRef = useRef(false);
  const lastRef = useRef<{ y: number; time: number } | null>(null);

  const setDetent = useCallback((next: DetentName) => {
    setDragHeight(null);
    setDetentState(next);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Interactive children opt out of dragging with data-no-drag.
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-no-drag]")) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      startRef.current = {
        y: event.clientY,
        time: event.timeStamp,
        detent,
        pointerId: event.pointerId,
      };
      lastRef.current = { y: event.clientY, time: event.timeStamp };
      movedRef.current = false;
      setIsDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [detent],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const start = startRef.current;
      if (!start) return;
      const dy = event.clientY - start.y;
      if (Math.abs(dy) > TAP_SLOP_PX) movedRef.current = true;
      lastRef.current = { y: event.clientY, time: event.timeStamp };
      setDragHeight(dragHeightPx(start.detent, dy, viewportHeight));
    },
    [viewportHeight],
  );

  const finish = useCallback(
    (event: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
      const start = startRef.current;
      startRef.current = null;
      setIsDragging(false);
      if (!start) return;
      event.currentTarget.releasePointerCapture?.(start.pointerId);

      const dy = event.clientY - start.y;
      const elapsed = Math.max(1, event.timeStamp - start.time);
      const last = lastRef.current;
      const velocity = last
        ? (last.y - start.y) / Math.max(1, last.time - start.time)
        : dy / elapsed;

      if (cancelled) {
        setDragHeight(null);
        return;
      }

      const isTap = !movedRef.current && elapsed < TAP_MAX_MS;
      if (isTap) {
        // Tap cycles peek -> half -> full -> peek. This is the keyboard/one-tap
        // equivalent of dragging, and there is no hover state anywhere.
        setDragHeight(null);
        setDetentState((current) =>
          current === "peek" ? "half" : current === "half" ? "full" : "peek",
        );
        return;
      }

      const release = resolveDragRelease({
        startDetent: start.detent,
        dyPx: dy,
        velocityPxPerMs: velocity,
        viewportHeight,
      });
      setDragHeight(null);
      setDetentState(release.detent);
    },
    [viewportHeight],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => finish(event, false),
    [finish],
  );
  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLElement>) => finish(event, true),
    [finish],
  );

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setDragHeight(null);
      setDetentState((current) => stepDetent(current, 1));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setDragHeight(null);
      setDetentState((current) => stepDetent(current, -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setDetentState("peek");
    } else if (event.key === "End") {
      event.preventDefault();
      setDetentState("full");
    }
  }, []);

  return {
    detent,
    setDetent,
    heightPx: dragHeight ?? detentHeightPx(detent, viewportHeight),
    isDragging,
    isSettling: !isDragging && dragHeight === null,
    dragHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown },
  };
}
