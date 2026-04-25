import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

type ContentProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
  className?: string;
};

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ContentProps
>(({ className = "", sideOffset = 4, align = "start", ...rest }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={`shadcn-menu ${className}`}
      {...rest}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

type ItemProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
  className?: string;
  active?: boolean;
};

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ItemProps
>(({ className = "", active, ...rest }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={`shadcn-menu-item${active ? " shadcn-menu-item--active" : ""} ${className}`}
    {...rest}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { className?: string }
>(({ className = "", ...rest }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} className={`shadcn-menu-label ${className}`} {...rest} />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> & { className?: string }
>(({ className = "", ...rest }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={`shadcn-menu-sep ${className}`} {...rest} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";
