// Six dots on a ring, like a pickleball (DESIGN.md: "lime disc with six dark dots").
const DOT_POSITIONS = Array.from({ length: 6 }, (_, index) => {
  const angle = (index * Math.PI) / 3;
  return { cx: 20 + 9 * Math.cos(angle), cy: 20 + 9 * Math.sin(angle) };
});

/** The club logo. Decorative: always placed next to the club or app name. */
export function ClubLogo({
  sizePx = 40,
  className = "",
}: {
  sizePx?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      width={sizePx}
      height={sizePx}
      viewBox="0 0 40 40"
      className={`shrink-0 ${className}`}
    >
      <circle cx="20" cy="20" r="20" className="fill-lime" />
      {DOT_POSITIONS.map(({ cx, cy }) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r="2.6"
          className="fill-on-lime"
        />
      ))}
    </svg>
  );
}
