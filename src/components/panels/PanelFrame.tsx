import type { ReactNode } from "react";
import "./PanelFrame.css";

interface PanelFrameProps {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function PanelFrame({ title, actions, children, className }: PanelFrameProps) {
  return (
    <div className={`pf-frame${className ? ` ${className}` : ""}`}>
      {(title || actions) && (
        <div className="pf-frame__header">
          <span className="pf-frame__title">{title}</span>
          {actions && <div className="pf-frame__actions">{actions}</div>}
        </div>
      )}
      <div className="pf-frame__body">{children}</div>
    </div>
  );
}
