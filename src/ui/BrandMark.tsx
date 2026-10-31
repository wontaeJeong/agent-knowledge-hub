import type { SVGProps } from "react";
import paths from "./brand-mark.json";

/** Approved Folio Wiki mark. Palette colors come from design tokens. */
export function BrandMark({
  size = 36,
  title,
  ...props
}: Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
  title?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title && <title>{title}</title>}
      <path
        d={paths.outerPath}
        stroke="var(--brand-mark-primary)"
        strokeWidth={paths.outerStrokeWidth}
        strokeLinejoin="round"
      />
      <path
        d={paths.innerPath}
        stroke="var(--brand-mark-secondary)"
        strokeWidth={paths.innerStrokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
