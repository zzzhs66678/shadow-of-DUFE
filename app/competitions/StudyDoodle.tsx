type DoodleKind = "数学" | "英语" | "创意设计" | "overview";

// Original paper-and-pencil marks; decorative, local and deliberately small.
export function StudyDoodle({ kind = "overview", className }: { kind?: DoodleKind; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden="true" focusable="false">
      <g stroke="var(--competition-ink, #211f1b)" strokeWidth="2.5" strokeLinejoin="miter">
        <path d="M19 17h51l10 10v60H19Z" fill="var(--competition-yellow, #e8c66a)" />
        <path d="M12 9h48l16 16v54H12Z" fill="var(--competition-paper, #f3f0e8)" />
        <path d="M60 9v16h16" />
        {kind === "英语" ? (
          <>
            <path d="M23 35h10q7 0 11 5 4-5 11-5h10v27H55q-7 0-11 5-4-5-11-5H23Z" />
            <path d="M44 40v27M28 44h9m-9 8h9m14-8h9m-9 8h9" />
          </>
        ) : kind === "创意设计" ? (
          <>
            <path d="M24 63V32l34 31Zm8-8V48l8 7Z" fill="var(--competition-yellow, #e8c66a)" />
            <path d="m48 47 17-17 6 6-17 17-9 3Z" fill="var(--competition-red, #a62126)" />
            <path d="m61 34 6 6" />
          </>
        ) : (
          <>
            <path d="M26 34v29h35" />
            <path d="m31 55 9-12 10 5 13-16" stroke="var(--competition-red, #a62126)" strokeWidth="3.5" />
            <path d="M25 24h16" />
          </>
        )}
        <path d="m73 52 7-7 6 6-7 7-14 14-9 3 3-9Z" fill="var(--competition-yellow, #e8c66a)" />
        <path d="m73 52 6 6M59 66l6 6" />
      </g>
    </svg>
  );
}
