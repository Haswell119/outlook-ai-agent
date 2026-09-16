import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold transition-colors whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-[#E1DFDD] text-[#424242]",
        low: "border-transparent bg-[#DFF6DD] text-[#107C10]",
        medium: "border-transparent bg-[#FFF4CE] text-[#8A6D00]",
        high: "border-transparent bg-[#FDE7E9] text-[#C4314B]",
        info: "border-transparent bg-[#E8F1FB] text-[#0F6CBD]",
        neutral: "border-transparent bg-[#F0F0F0] text-[#616161]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
