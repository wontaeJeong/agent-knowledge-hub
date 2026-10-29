import type { SVGProps } from "react";
import icons from "./brand-icons.json";

export type BrandIconName = keyof typeof icons;

/** Shared vector source for app navigation, standalone SVGs, and the brand pack. */
export function BrandIcon({
  name,
  size = 20,
  title,
  ...props
}: SVGProps<SVGSVGElement> & {
  name: BrandIconName;
  size?: number;
  title?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title && <title>{title}</title>}
      <path d={icons[name]} />
    </svg>
  );
}
