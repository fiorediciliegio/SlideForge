import { Beaker, FlaskConical, FolderOpen, Home, Layers, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Messages } from "../../../i18n/messages";
import type { PageId } from "../types";

interface EntrySidebarProps {
  t: Messages;
  page: PageId;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onHome: () => void;
  onMyWork: () => void;
  onMyTemplates: () => void;
  batchTestingEnabled?: boolean;
  onBatchTesting?: () => void;
  webResearchLabEnabled?: boolean;
  onWebResearchLab?: () => void;
}

/**
 * The entry pages replace the panel header with this rail, so it carries the
 * brand and the entry page links. Collapsed it keeps the links as icons only.
 */
export function EntrySidebar(props: EntrySidebarProps) {
  const {
    t,
    page,
    collapsed,
    onToggleCollapsed,
    onHome,
    onMyWork,
    onMyTemplates,
    batchTestingEnabled = false,
    onBatchTesting,
    webResearchLabEnabled = false,
    onWebResearchLab,
  } = props;
  const toggleLabel = collapsed ? t.controls.expandSidebar : t.controls.collapseSidebar;

  return (
    <aside className={`entry-sidebar ${collapsed ? "collapsed" : ""}`} aria-label={t.appName}>
      {/* The toggle leads the row so its icon lines up with the nav icons below. */}
      <div className="entry-sidebar-brand">
        <button
          data-performance-id="navigation.new-presentation"
          type="button"
          className="entry-sidebar-toggle"
          onClick={onToggleCollapsed}
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={16} aria-hidden="true" />
          )}
        </button>
        {collapsed ? null : <span className="app-title">{t.appName}</span>}
      </div>
      <nav className="entry-sidebar-nav" aria-label={t.myWork.home}>
        <button
          data-performance-id="navigation.my-work"
          type="button"
          className={page === "main" ? "active" : ""}
          aria-current={page === "main" ? "page" : undefined}
          onClick={onHome}
          title={collapsed ? t.myWork.home : undefined}
          aria-label={collapsed ? t.myWork.home : undefined}
        >
          <Home size={16} aria-hidden="true" />
          {collapsed ? null : t.myWork.home}
        </button>
        <button
          data-performance-id="navigation.collapse"
          type="button"
          className={page === "my-work" ? "active" : ""}
          aria-current={page === "my-work" ? "page" : undefined}
          onClick={onMyWork}
          title={collapsed ? t.myWork.navTitle : undefined}
          aria-label={collapsed ? t.myWork.navTitle : undefined}
        >
          <FolderOpen size={16} aria-hidden="true" />
          {collapsed ? null : t.myWork.navTitle}
        </button>
        <button type="button" data-performance-id="navigation.my-templates"
          className={page === "my-templates" ? "active" : ""}
          aria-current={page === "my-templates" ? "page" : undefined}
          onClick={onMyTemplates} title={collapsed ? t.userTemplates.title : undefined}
          aria-label={collapsed ? t.userTemplates.title : undefined}>
          <Layers size={16} aria-hidden="true" />
          {collapsed ? null : t.userTemplates.title}
        </button>
        {batchTestingEnabled && onBatchTesting ? (
          <button
            data-performance-id="navigation.batch-testing"
            type="button"
            className={page === "batch-testing" ? "active" : ""}
            aria-current={page === "batch-testing" ? "page" : undefined}
            onClick={onBatchTesting}
            title={collapsed ? t.batchTesting.title : undefined}
            aria-label={collapsed ? t.batchTesting.title : undefined}
          >
            <FlaskConical size={16} aria-hidden="true" />
            {collapsed ? null : t.batchTesting.title}
          </button>
        ) : null}
        {webResearchLabEnabled && onWebResearchLab ? (
          <button
            data-performance-id="navigation.web-research-lab"
            type="button"
            className={page === "web-research-lab" ? "active" : ""}
            aria-current={page === "web-research-lab" ? "page" : undefined}
            onClick={onWebResearchLab}
            title={collapsed ? t.webResearchLab.title : undefined}
            aria-label={collapsed ? t.webResearchLab.title : undefined}
          >
            <Beaker size={16} aria-hidden="true" />
            {collapsed ? null : t.webResearchLab.title}
          </button>
        ) : null}
      </nav>
    </aside>
  );
}
