import { Fragment, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface ListTab {
  id: string;
  label: string;
}

interface ListTabsProps {
  tabs: ListTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  label?: string;
}

/** Underline tabs; the active tab carries the accent underline. */
export function ListTabs({ tabs, activeTab, onTabChange, label = "Filter" }: ListTabsProps) {
  return (
    <div role="tablist" aria-label={label} className="flex items-stretch gap-4 self-stretch">
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTabChange(tab.id)}
            className={`relative text-preview -outline-offset-2 px-0.5 transition-colors ${
              active ? "text-text-primary font-medium" : "text-text-tertiary hover:text-text-primary"
            }`}
          >
            {tab.label}
            <span
              aria-hidden
              className={`absolute inset-x-0 -bottom-px h-0.5 rounded-full ${active ? "bg-accent" : "bg-transparent"}`}
            />
          </button>
        );
      })}
    </div>
  );
}

interface ListHeaderProps {
  /** Context path shown above the title, e.g. ["Mail", account] */
  breadcrumb?: string[];
  title: ReactNode;
  /** Shown as a badge after the title */
  count?: number;
  /** Noun for the badge tooltip, pluralised with "s" */
  countNoun?: string;
  icon?: ReactNode;
  /** Buttons at the right of the title row */
  actions?: ReactNode;
  tabs?: ListTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  /** Controls at the right of the tab row */
  toolbar?: ReactNode;
  /** Optional custom tab row content (used instead of `tabs`) */
  tabRow?: ReactNode;
}

/** Page header for mail-style lists: breadcrumb, title with count, then a tab row. */
export function ListHeader({
  breadcrumb,
  title,
  count,
  countNoun = "conversation",
  icon,
  actions,
  tabs,
  activeTab,
  onTabChange,
  toolbar,
  tabRow,
}: ListHeaderProps) {
  const hasTabRow = Boolean(tabRow) || (tabs && activeTab !== undefined && onTabChange) || Boolean(toolbar);
  return (
    <header className="no-select shrink-0 border-b border-border-secondary">
      <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0">
          {breadcrumb && breadcrumb.length > 0 && (
            <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-meta text-text-tertiary mb-1 min-w-0">
              {breadcrumb.map((crumb, i) => (
                <Fragment key={`${crumb}-${i}`}>
                  {i > 0 && <ChevronRight size={11} aria-hidden className="shrink-0" />}
                  <span className="truncate">{crumb}</span>
                </Fragment>
              ))}
            </nav>
          )}
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <h1 className="text-title font-semibold text-text-primary truncate">{title}</h1>
            {count !== undefined && (
              <span
                title={`${count} ${countNoun}${count === 1 ? "" : "s"}`}
                className="shrink-0 text-meta tabular-nums font-medium text-text-secondary border border-border-primary rounded-md px-1.5 py-px"
              >
                {count}
              </span>
            )}
          </div>
        </div>
        {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
      </div>
      {hasTabRow && (
        <div className="flex items-stretch justify-between gap-3 h-9 px-4">
          {tabRow ??
            (tabs && activeTab !== undefined && onTabChange ? (
              <ListTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
            ) : (
              <span />
            ))}
          {toolbar && <div className="flex items-center gap-1">{toolbar}</div>}
        </div>
      )}
    </header>
  );
}
