import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * A modal, in the system's own surfaces.
 *
 * The browser's `confirm()` and `prompt()` were doing this job. They are drawn
 * by the operating system, so they carry none of the application's type,
 * colour or spacing — and on a dark interface they arrive as a bright grey box
 * that looks like it belongs to a different program. They also block the whole
 * tab while open and cannot be styled at all.
 *
 * Radix supplies the parts that are genuinely hard: focus is trapped inside and
 * restored to whatever opened the dialog, Escape closes, the page behind is
 * inert to a screen reader, and scroll is locked. What is added here is the
 * appearance — surface, hairline, radius from the design system, no shadow,
 * because the system says depth comes from surface contrast.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      {/* Dim rather than blur: a blurred backdrop costs a repaint on every
          frame of a page that is streaming telemetry behind it. */}
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-[440px]",
          "-translate-x-1/2 -translate-y-1/2",
          "rounded-lg border border-hairline bg-surface p-6",
          "focus:outline-none",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="Close">
            <X />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("pr-8 text-title-md font-semibold text-ink", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("mt-2 text-body text-muted", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mt-6 flex flex-wrap justify-end gap-2", className)}
      {...props}
    />
  );
}

/**
 * Ask before doing something that cannot be taken back with one click.
 *
 * The confirming button carries the weight of what it does: `danger` when the
 * action ends a flight or suspends somebody, so the two buttons are not two
 * identical rectangles a person picks between by reading carefully.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  confirmVariant = "default",
  onConfirm,
  busy = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  confirmVariant?: "default" | "danger";
  onConfirm: () => void;
  busy?: boolean;
  /** Anything the dialog needs to ask for as well as confirm — a reason, a name. */
  children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={(e) => {
          // Enter confirms, unless the focus is in a multi-line field where a
          // newline is what the key is for.
          if (e.key === "Enter" && !busy && !(e.target as HTMLElement).matches("textarea")) {
            e.preventDefault();
            onConfirm();
          }
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        {children && <div className="mt-4">{children}</div>}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
