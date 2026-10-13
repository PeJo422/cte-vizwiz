import { useRef, type KeyboardEvent, type PointerEvent } from "react";

interface Props {
  /** "vertical" = lodrät list som dras i sidled (ändrar bredd), "horizontal" = vågrät list som dras uppåt/nedåt (ändrar höjd). */
  orientation: "vertical" | "horizontal";
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** Dubbelklick / Enter återställer. */
  onReset?: () => void;
  /** Panelen ligger efter listen (höger/under), så dragning mot panelen ska minska storleken. */
  invert?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function Splitter({ orientation, label, value, min, max, onChange, onReset, invert = false }: Props) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const vertical = orientation === "vertical";
  const pos = (e: { clientX: number; clientY: number }) => (vertical ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: pos(e), value };
    document.body.classList.add("is-resizing", vertical ? "is-resizing-x" : "is-resizing-y");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = pos(e) - d.start;
    onChange(clamp(d.value + (invert ? -delta : delta), min, max));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("is-resizing", "is-resizing-x", "is-resizing-y");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const grow = vertical ? "ArrowRight" : "ArrowDown";
    const shrink = vertical ? "ArrowLeft" : "ArrowUp";
    let next: number | null = null;
    if (e.key === grow) next = value + (invert ? -step : step);
    else if (e.key === shrink) next = value + (invert ? step : -step);
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else if (e.key === "Enter" && onReset) return onReset();
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next, min, max));
  };

  return (
    <div
      className={`splitter splitter--${orientation}`}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label}. Dra, eller använd piltangenter. Dubbelklick återställer.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="splitter__grip" aria-hidden="true" />
    </div>
  );
}
