import type { ReactNode } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { usePanelStore } from "../../stores/panelStore";
import PanelFrame from "./PanelFrame";
import "./PanelFrame.css";

interface LeftPanelContainerProps {
  /** Left panel content (e.g. file tree, session list). */
  left?: ReactNode;
  /** Main center pane (canvas, editor, etc.). */
  center: ReactNode;
  /** Optional right panel (chat, details). */
  right?: ReactNode;
  leftTitle?: string;
  rightTitle?: string;
  groupId?: string;
}

const LEFT_ID = "t64-panel-left";
const CENTER_ID = "t64-panel-center";
const RIGHT_ID = "t64-panel-right";

export default function LeftPanelContainer({
  left,
  center,
  right,
  leftTitle = "Panel",
  rightTitle = "Inspector",
  groupId = "t64-main-layout",
}: LeftPanelContainerProps) {
  const sizes = usePanelStore((s) => s.sizes);
  const setSizes = usePanelStore((s) => s.setSizes);

  const defaultLayout: Layout = {
    [LEFT_ID]: sizes.left,
    [CENTER_ID]: sizes.center,
    [RIGHT_ID]: sizes.right,
  };

  const handleLayoutChanged = (layout: Layout) => {
    const l = layout[LEFT_ID] ?? sizes.left;
    const c = layout[CENTER_ID] ?? sizes.center;
    const r = layout[RIGHT_ID] ?? sizes.right;
    setSizes([l, c, r]);
  };

  return (
    <div className="pf-container">
      <Group
        id={groupId}
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={handleLayoutChanged}
        style={{ width: "100%", height: "100%" }}
      >
        {left != null && (
          <>
            <Panel id={LEFT_ID} defaultSize={sizes.left} minSize={12} maxSize={40}>
              <PanelFrame title={leftTitle}>{left}</PanelFrame>
            </Panel>
            <Separator className="pf-handle" />
          </>
        )}

        <Panel id={CENTER_ID} defaultSize={sizes.center} minSize={30}>
          <PanelFrame>{center}</PanelFrame>
        </Panel>

        {right != null && (
          <>
            <Separator className="pf-handle" />
            <Panel id={RIGHT_ID} defaultSize={sizes.right} minSize={12} maxSize={40}>
              <PanelFrame title={rightTitle}>{right}</PanelFrame>
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
