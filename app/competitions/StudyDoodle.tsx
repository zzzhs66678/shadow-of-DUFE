type DoodleKind = "数学" | "英语" | "创意设计" | "overview";

// Local SVG drawings stay decorative and make no extra image requests.
export function StudyDoodle({ kind = "overview", className }: { kind?: DoodleKind; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 260 200" fill="none" aria-hidden="true" focusable="false">
      <g stroke="#25364c" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m219 28 4 12 12 3-11 6-1 12-8-10-12 2 7-10-5-11Z" fill="#f5d56d" />
        <path d="m30 145 3 7 8 2-7 4-1 8-5-6-8 1 5-7-3-7Z" fill="#d9d0ef" />
        {kind === "英语" ? (
          <>
            <path d="M49 79q35-22 76-6 37-17 75 2l-1 91q-34-12-72 1-37-13-76 1Z" fill="#fffdf5" />
            <path d="M125 76v88M49 160l-6 14q41-4 83 5 38-10 78-4l-5-12" />
            <path d="m66 98 37-4m-36 18 35-2m-34 18 22-1m52-32 38 2m-37 18 35 1m-34 17 22 1" stroke="#aaa0c4" />
            <path d="M79 24q43-13 78 0l-2 36-21 0-10 13-5-13-42 1Z" fill="#c9bce7" />
            <path d="m92 49 6-15 6 15m-9-6h6m11-8v14h6q8-7-1-8 7-8-5-6m29 1q-13-5-13 8t13 2" />
            <circle cx="111" cy="144" r="1.5" fill="#25364c" /><circle cx="136" cy="144" r="1.5" fill="#25364c" />
            <path d="M118 151q7 6 13 0" />
          </>
        ) : kind === "创意设计" ? (
          <>
            <path d="M129 43c-49-5-91 31-87 73 4 41 57 66 90 47 20-11-8-26 6-33 20-10 51 8 63-15 19-35-28-68-72-72Z" fill="#ffe3cd" />
            <ellipse cx="155" cy="109" rx="12" ry="9" fill="#fffdf5" transform="rotate(-22 155 109)" />
            <circle cx="76" cy="97" r="11" fill="#a8c9e1" /><circle cx="112" cy="73" r="11" fill="#d3bce6" />
            <circle cx="155" cy="76" r="10" fill="#f4ce67" /><circle cx="76" cy="137" r="10" fill="#b5d5bd" />
            <path d="m164 157 48-96 13 7-47 98-13 12Z" fill="#b6cddb" />
            <path d="m212 61 3-17q12-20 17-14-4 5-1 16l-6 22Z" fill="#a4c7ad" />
            <path d="m181 146-13-7" />
          </>
        ) : (
          <>
            <g transform="rotate(-9 130 108)">
              <rect x="62" y="35" width="126" height="138" rx="9" fill={kind === "overview" ? "#d3c8eb" : "#b8d7c1"} />
              <path d="M72 42h111v124H72Z" fill="#fffdf5" />
              <path d="M84 56v102m18-102v102m18-102v102m18-102v102m18-102v102M79 77h93M79 96h93M79 115h93M79 134h93" stroke="#d5e3eb" strokeWidth="1" />
              <path d="m57 58 14 0m-14 24h14m-14 24h14m-14 24h14m-14 24h14" />
              <path d="M91 125v-35m0 35h63m-51-11q12-4 19-15t29-15" stroke="#558f86" />
              <circle cx="115" cy="144" r="1.5" fill="#25364c" /><circle cx="139" cy="144" r="1.5" fill="#25364c" />
              <path d="M120 152q7 6 13 0" />
            </g>
            <g transform="rotate(26 192 114)">
              <path d="M184 52h17v95l-8 18-9-18Z" fill="#f4d26c" />
              <path d="M184 52v-9q8-7 17 0v9" fill="#e5aaa1" />
              <path d="M184 62h17m-9 2v78m-8 5h17m-12 10h8" />
            </g>
            <path d="m36 57 12 2m-5-8-2 15M215 159l14 4m-8-10-2 15" stroke="#64988a" />
          </>
        )}
        <path d="M58 181q65 7 144-2" stroke="#25364c" strokeOpacity=".18" />
      </g>
    </svg>
  );
}
