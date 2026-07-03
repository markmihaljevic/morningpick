"use client";

import { useState } from "react";

export interface DeckMemo {
  id: string;
  ticker: string;
  companyName: string | null;
  title: string;
  dateLine: string;
  kind: string;
  oneLiner: string | null;
  conviction: number | null;
  horizon: string | null;
  styleTags: string[];
  stats: { label: string; value: string }[];
  pdfUrl: string;
}

/**
 * The flippable stack of past research notes — the same paper-note artifact
 * as the landing hero, but live: arrows (or the keyboard) leaf through the
 * subscriber's real memo history.
 */
export function MemoDeck({ memos }: { memos: DeckMemo[] }) {
  const [index, setIndex] = useState(0);
  const [turning, setTurning] = useState(false);
  const memo = memos[index];

  const go = (next: number) => {
    if (next < 0 || next >= memos.length || next === index) return;
    setTurning(true);
    setTimeout(() => {
      setIndex(next);
      setTurning(false);
    }, 140);
  };

  return (
    <div className="grid items-start gap-10 lg:grid-cols-[0.9fr_1.1fr]">
      {/* Left: index list */}
      <ol className="order-2 max-h-[520px] overflow-y-auto pr-2 lg:order-1">
        {memos.map((m, i) => (
          <li key={m.id}>
            <button
              onClick={() => go(i)}
              className={`group flex w-full items-baseline gap-4 border-b border-white/10 px-2 py-3.5 text-left transition-colors hover:bg-white/5 ${
                i === index ? "bg-white/5" : ""
              }`}
            >
              <span className="w-[86px] shrink-0 font-mono text-[10px] tracking-[0.1em] text-[#5C7183]">
                {m.dateLine.toUpperCase().replace(/ 20\d\d$/, "")}
              </span>
              <span
                className={`shrink-0 font-mono text-[12px] font-bold tracking-wide ${
                  i === index ? "text-[#B08C3D]" : "text-[#FBFAF6] group-hover:text-[#B08C3D]"
                }`}
              >
                {m.ticker}
              </span>
              <span className="truncate text-[13px] text-[#8FA0B0]">
                {m.title.replace(/^[A-Z0-9.\-]+ — /, "")}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/* Right: the note artifact */}
      <div className="order-1 lg:order-2">
        <div className="relative">
          {/* sheets peeking behind — the rest of the stack */}
          {memos.length > index + 1 && (
            <div className="absolute -right-3 top-4 h-full w-full rotate-2 rounded-sm bg-[#e8e4d8] shadow-xl" />
          )}
          {memos.length > index + 2 && (
            <div className="absolute -right-1.5 top-2 h-full w-full rotate-1 rounded-sm bg-[#f1eee4] shadow-xl" />
          )}

          <div
            className={`relative rounded-sm bg-[#FBFAF6] text-[#10202F] shadow-2xl transition-all duration-150 ${
              turning ? "translate-x-3 rotate-1 opacity-0" : "opacity-100"
            }`}
          >
            <div className="flex items-center justify-between rounded-t-sm border-b-2 border-[#B08C3D] bg-[#10202F] px-5 py-3">
              <span className="font-sans text-[11px] tracking-[0.3em] text-[#FBFAF6]">
                MORNING<span className="font-bold">PICK</span>
              </span>
              <span className="font-mono text-[9px] tracking-widest text-[#8FA0B0]">
                {memo.dateLine.toUpperCase()}
              </span>
            </div>

            <div className="px-5 py-4">
              <p className="font-mono text-[8px] tracking-[0.2em] text-[#5C6670]">
                {memo.kind} · {memo.companyName?.toUpperCase() ?? memo.ticker}
              </p>
              <h3 className="mt-2 font-serif text-[19px] leading-snug font-bold">{memo.title}</h3>

              {(memo.conviction !== null || memo.styleTags.length > 0) && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 bg-[#10202F] px-3 py-1.5">
                  {memo.conviction !== null && (
                    <span className="font-mono text-[9px] tracking-[0.12em] text-[#8FA0B0]">
                      CONVICTION <span className="text-[#B08C3D]">{memo.conviction}/10</span>
                    </span>
                  )}
                  {memo.horizon && (
                    <span className="font-mono text-[9px] tracking-[0.12em] text-[#FBFAF6]">
                      {memo.horizon.toUpperCase()}
                    </span>
                  )}
                  {memo.styleTags.map((t) => (
                    <span
                      key={t}
                      className="font-mono text-[9px] tracking-[0.12em] text-[#8FA0B0]"
                    >
                      {t.toUpperCase()}
                    </span>
                  ))}
                </div>
              )}

              {memo.stats.length > 0 && (
                <div className="mt-3 grid grid-cols-3 gap-px border border-[#E4E0D5] bg-[#E4E0D5]">
                  {memo.stats.map((s) => (
                    <div key={s.label} className="bg-white px-2.5 py-1.5">
                      <p className="font-mono text-[7px] tracking-wider text-[#5C6670]">
                        {s.label.toUpperCase()}
                      </p>
                      <p className="font-sans text-[12px] font-bold">{s.value}</p>
                    </div>
                  ))}
                </div>
              )}

              {memo.oneLiner && (
                <p className="mt-3.5 border-l-2 border-[#B08C3D] pl-3 font-serif text-[14px] leading-relaxed italic">
                  {memo.oneLiner}
                </p>
              )}
            </div>

            <div className="rounded-b-sm px-5 pb-4">
              <div className="flex items-center justify-between border-t border-[#E4E0D5] pt-3">
                <a
                  href={memo.pdfUrl}
                  className="font-mono text-[9px] tracking-widest text-[#10202F] underline decoration-[#B08C3D] underline-offset-4 hover:text-[#B08C3D]"
                >
                  READ THE FULL NOTE (PDF) ↧
                </a>
                <span className="font-mono text-[8px] tracking-widest text-[#5C6670]">
                  {index + 1} / {memos.length}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Flip controls */}
        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={() => go(index + 1)}
            disabled={index >= memos.length - 1}
            className="border border-[#B08C3D] px-4 py-1.5 font-mono text-[11px] tracking-[0.15em] text-[#B08C3D] transition-colors hover:bg-[#B08C3D] hover:text-[#0B1622] disabled:cursor-default disabled:border-white/15 disabled:text-[#5C7183] disabled:hover:bg-transparent"
          >
            ← OLDER
          </button>
          <button
            onClick={() => go(index - 1)}
            disabled={index === 0}
            className="border border-[#B08C3D] px-4 py-1.5 font-mono text-[11px] tracking-[0.15em] text-[#B08C3D] transition-colors hover:bg-[#B08C3D] hover:text-[#0B1622] disabled:cursor-default disabled:border-white/15 disabled:text-[#5C7183] disabled:hover:bg-transparent"
          >
            NEWER →
          </button>
        </div>
      </div>
    </div>
  );
}
