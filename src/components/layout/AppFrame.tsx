import type { ReactNode } from "react";
import { IS_MAC, TitleBar } from "./TitleBar";

interface AppFrameProps {
  sidebar: ReactNode;
  sidebarCollapsed: boolean;
  /** Status bar shown at the bottom of the content panel */
  footer?: ReactNode;
  /** Shown above the routed content, in the layout's flow so it pushes the page down instead of covering it */
  banner?: ReactNode;
  children: ReactNode;
  isMac?: boolean;
}

/**
 * Window shell: the frame takes the translucent sidebar colour, the sidebar sits
 * on it, and the routed content plus footer live in an inset rounded panel.
 * macOS draws its own traffic lights over a drag area above the sidebar; other
 * platforms keep the title bar row with window controls.
 */
export function AppFrame({ sidebar, sidebarCollapsed, footer, banner, children, isMac = IS_MAC }: AppFrameProps) {
  const panelTop = !isMac ? "none" : sidebarCollapsed ? "titlebar" : "gap";
  return (
    <div className="app-frame glass-sidebar flex flex-col flex-1 min-h-0 h-full">
      {!isMac && <TitleBar />}
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col shrink-0 min-h-0">
          {isMac && <div data-tauri-drag-region className="h-[var(--titlebar-height)] shrink-0" />}
          <div className="flex flex-1 min-h-0">{sidebar}</div>
        </div>
        <div className="relative flex flex-col flex-1 min-w-0 min-h-0">
          {isMac && (
            <div
              data-tauri-drag-region
              className={`absolute top-0 inset-x-0 ${panelTop === "titlebar" ? "h-[var(--titlebar-height)]" : "h-[var(--frame-gap)]"}`}
            />
          )}
          <main data-top={panelTop} className="app-panel flex flex-col flex-1 min-w-0 min-h-0">
            {banner}
            <div className="flex flex-1 min-w-0 min-h-0">{children}</div>
            {footer}
          </main>
        </div>
      </div>
    </div>
  );
}
