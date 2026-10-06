import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The design system's button, to the letter: 40px tall, 8px radius, Inter 600
 * at 14px, 12×20 padding.
 *
 * `default` is the yellow CTA — the brand voltage, and the document is explicit
 * that its power comes from scarcity. One per view, on the action that moves the
 * person forward. Everything else is `secondary` on the card surface.
 *
 * There is no rounded-pill variant. The system reserves the pill for badges and
 * says so directly: "Don't use rounded buttons / pills outside of small badges."
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md " +
    "text-body font-semibold transition-colors " +
    "disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-on-primary hover:bg-primary-active " +
          "disabled:bg-primary-disabled disabled:text-muted",
        secondary:
          "bg-surface text-ink border border-hairline hover:bg-elevated " +
          "disabled:opacity-50",
        ghost: "text-body hover:bg-surface hover:text-ink disabled:opacity-50",
        // Destructive keeps the dark surface and speaks through its text, so a
        // row of actions does not turn into a row of competing colour.
        danger:
          "bg-surface text-danger border border-hairline hover:bg-danger-soft " +
          "disabled:opacity-50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-5 py-3",
        sm: "h-8 px-3 text-caption",
        icon: "h-9 w-9 rounded-full",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
