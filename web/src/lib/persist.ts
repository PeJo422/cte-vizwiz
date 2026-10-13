import { useCallback, useState } from "react";

const PREFIX = "cte-vizwiz:";

/** Som useState, men värdet överlever omladdning. Lagring som saknas eller är blockerad ignoreras tyst. */
export function usePersistentState<T>(key: string, initial: T, valid: (v: unknown) => v is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (valid(parsed)) return parsed;
      }
    } catch {
      /* ignorera */
    }
    return initial;
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(next));
      } catch {
        /* ignorera */
      }
    },
    [key],
  );
  return [value, set] as const;
}

export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isString = (v: unknown): v is string => typeof v === "string";
export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
