import { MSSQL, sql as sqlLang } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

import type { Span } from "../ir";

export interface Highlights {
  node: Span | null;
  column: Span | null;
}

export interface RevealRequest {
  span: Span;
  nonce: number;
}

const setHighlights = StateEffect.define<Highlights>();

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setHighlights)) continue;
      const len = tr.state.doc.length;
      const ranges: Range<Decoration>[] = [];
      const add = (s: Span | null, cls: string) => {
        if (s && s.start < s.end && s.end <= len) ranges.push(Decoration.mark({ class: cls }).range(s.start, s.end));
      };
      add(e.value.node, "cm-node-hl");
      add(e.value.column, "cm-col-hl");
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--surface)", color: "var(--ink)" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: "var(--surface-2)", color: "var(--muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  "&.cm-focused": { outline: "2px solid var(--accent)", outlineOffset: "-2px" },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
  ".cm-jinja": { backgroundColor: "var(--jinja-bg)", color: "var(--jinja-ink)", borderRadius: "3px" },
  ".cm-jinja-comment": { color: "var(--muted)", fontStyle: "italic" },
  ".cm-node-hl": { backgroundColor: "var(--hl-node)", borderRadius: "2px" },
  ".cm-col-hl": { backgroundColor: "var(--hl-col)", borderRadius: "2px", outline: "1px solid var(--accent)" },
});

// Färger via CSS-variabler så att syntaxen följer ljust/mörkt läge.
const tokens = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--tok-kw)", fontWeight: "600" },
    { tag: [t.string, t.special(t.string)], color: "var(--tok-str)" },
    { tag: [t.number, t.bool, t.null], color: "var(--tok-num)" },
    { tag: [t.lineComment, t.blockComment], color: "var(--muted)", fontStyle: "italic" },
    { tag: [t.typeName, t.className], color: "var(--tok-type)" },
    { tag: [t.function(t.variableName), t.standard(t.name)], color: "var(--tok-fn)" },
  ]),
);

// Mittenknapp + dra = panorera editorn i sidled/höjdled. (Vänsterknapp markerar text och
// Alt+dra är rektangelmarkering i CodeMirror, så de används inte.) Hjul/styrplatta och
// scrollistarna fungerar som vanligt.
const panWithMiddleButton = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 1) return false;
    e.preventDefault();
    const scroller = view.scrollDOM;
    const start = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    scroller.classList.add("is-panning");
    const move = (m: MouseEvent) => {
      scroller.scrollLeft = start.left - (m.clientX - start.x);
      scroller.scrollTop = start.top - (m.clientY - start.y);
    };
    const up = () => {
      scroller.classList.remove("is-panning");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return true;
  },
});

// Jinja-taggar ({{ }}, {% %}, {# #}) får egen bakgrund så att dbt-kod och SQL går att skilja åt.
const jinjaMatcher = new MatchDecorator({
  regexp: /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g,
  decoration: (m) => Decoration.mark({ class: m[0].startsWith("{#") ? "cm-jinja-comment" : "cm-jinja" }),
});
const jinjaTags = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = jinjaMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = jinjaMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const wrapping = new Compartment();

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Bryt långa rader i stället för att scrolla i sidled. */
  wrap: boolean;
  highlights: Highlights;
  /** Sätts bara när valet kom från visualiseringen – då scrollar editorn till koden. */
  reveal: RevealRequest | null;
  /** Användaren klickade/flyttade markören i editorn. */
  onCursor: (offset: number) => void;
}

export function EditorPane({ value, onChange, wrap, highlights, reveal, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onCursor });
  cb.current = { onChange, onCursor };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          sqlLang({ dialect: MSSQL }),
          theme,
          highlightField,
          tokens,
          panWithMiddleButton,
          jinjaTags,
          wrapping.of(wrap ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({ "aria-label": "SQL-kod" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            else if (u.selectionSet && u.transactions.some((t) => t.isUserEvent("select"))) {
              cb.current.onCursor(u.state.selection.main.head);
            }
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editorn skapas en gång
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  // externa textbyten (exempel-val)
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setHighlights.of(highlights) });
  }, [highlights, value]);

  useEffect(() => {
    const v = view.current;
    if (!v || !reveal || reveal.span.end > v.state.doc.length) return;
    v.dispatch({ effects: EditorView.scrollIntoView(reveal.span.start, { y: "center" }) });
  }, [reveal]);

  return <div className="editor" ref={host} />;
}
