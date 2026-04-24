import type { ReactNode } from "react";
import "./Kbd.css";

interface KbdProps {
  children: ReactNode;
  className?: string;
}

export default function Kbd({ children, className }: KbdProps) {
  const combined = `t64-kbd${className ? ` ${className}` : ""}`;
  return <kbd className={combined}>{children}</kbd>;
}
