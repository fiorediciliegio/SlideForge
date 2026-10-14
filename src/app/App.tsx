import { slideFormat, SlideAspectRatioContext } from "../slideFormat";
import type { CSSProperties } from "react";
import { PageRegenerationPage, PageRegenerationSetupPage } from "../features/page-regeneration/PageRegeneration";
import { useMemo, useState } from "react";
import { Presentation } from "lucide-react";
import { BriefPage } from "../features/deck-workspace/components/BriefPage";
import { DeckPage } from "../features/deck-workspace/components/DeckPage";
import { EntrySidebar } from "../features/deck-workspace/components/EntrySidebar";
import { EntryTopControls } from "../features/deck-workspace/components/EntryTopControls";
import { ExportPage } from "../features/deck-workspace/components/ExportPage";
import { GeneratingPage } from "../features/deck-workspace/components/GeneratingPage";
import { StoppingGenerationOverlay } from "../features/deck-workspace/components/StoppingGenerationOverlay";
import { LibraryPage } from "../features/deck-workspace/components/LibraryPage";
import { MyWorkPage } from "../features/deck-workspace/components/MyWorkPage";
import { OutlinePage } from "../features/deck-workspace/components/OutlinePage";
import { WebResearchPage } from "../features/deck-workspace/components/WebResearchPage";
import { PanelHeader } from "../features/deck-workspace/components/PanelHeader";
import {
  adjacentEnabledStage,
  ProgressLine,
  shouldShowProgressLine,
  type ProgressStageAvailability,
} from "../features/deck-workspace/components/ProgressLine";
import { ReviewPage } from "../features/deck-workspace/components/ReviewPage";
import { RefinePage } from "../features/deck-workspace/components/RefinePage";
import {
  confirmedRequirementsAllowOutline,
  PresentationRequirementsPage,
} from "../features/requirements";
import { ConfirmationDialog } from "../features/deck-workspace/components/ConfirmationDialog";
import { CloudSyncNoticeDialog } from "../features/deck-workspace/components/CloudSyncNoticeDialog";
import { useDeckWorkspace } from "../features/deck-workspace/hooks/useDeckWorkspace";
import { summarizeUserFacingError } from "../features/deck-workspace/userFacingError";
import { VISUAL_STYLE_PRESETS } from "../features/templates/visualStylePresets";
import { UserTemplatesPage } from "../features/user-templates/UserTemplatesPage";
import { useI18n } from "../i18n/useI18n";
import { ManualPageEditorShell } from "../features/manual-page-editor/ManualPageEditorShell";
import { PerformanceReportPage } from "../features/performance/PerformanceReportPage";
import { BatchTestingPage } from "../features/batch-testing/BatchTestingPage";
import { WebResearchLabPage } from "../features/web-research-lab/WebResearchLabPage";

export function App() {
  const { locale, setLocale, t } = useI18n();
  const { state, actions, pageRegeneration } = useDeckWorkspace(t, locale);
  const [manualEditorOpen, setManualEditorOpen] = useState(false);
  const [entrySidebarCollapsed, setEntrySidebarCollapsed] = useState(false);
  const manualEditorPages = useMemo(() => {
    const rendered = state.reviewRender.result?.slides ?? [];
    const progressPages = state.pageProgress?.pages ?? [];
    if (rendered.length > 0) return rendered.map((slide) => ({
      pageId: slide.slide_id,
      title: slide.title,
      previewVersion: slide.preview_version ?? slide.preview_source_fingerprint
        ?? state.generationPagePreviews[slide.slide_id]?.renderSourceFingerprint,
    }));
    return progressPages.map((item, index) => ({
      pageId: item.page_id,
      title: state.deck[index]?.title ?? state.outline[index]?.title ?? item.page_id,
      previewVersion: state.generationPagePreviews[item.page_id]?.renderSourceFingerprint,
    }));
  }, [state.deck, state.generationPagePreviews, state.outline, state.pageProgress, state.reviewRender.result]);
  const refineSlideIndex = state.deck.length > 0
    ? Math.min(Math.max(state.currentSlide, 0), state.deck.length - 1)
    : 0;
  const refineSlide = state.deck[refineSlideIndex] ?? (
    state.outline[refineSlideIndex]
      ? { title: state.outline[refineSlideIndex].title, subtitle: "" }
      : null
  );
  const showBatchTestingPage = state.page === "batch-testing";
  const showWebResearchLabPage = state.page === "web-research-lab";
  const showEntrySidebar = !showBatchTestingPage && !showWebResearchLabPage && (
    (state.page === "main" && state.stage === "brief") ||
    state.page === "my-work" || state.page === "my-templates"
  );
  const showProgressLine = shouldShowProgressLine({
    page: state.page,
    stage: state.stage,
    requirementsStatus: state.presentationRequirements.status,
    hasGenerationProgress: state.createDeckProgress !== null,
    hasGeneratedDeck: state.generated,
    pageProgressCount: state.pageProgress?.pages.length ?? 0,
  });
  const stageAvailability: ProgressStageAvailability = {
    brief: true,
    requirements: state.presentationRequirements.status !== "empty",
    // Confirmation commits the requirements asynchronously, so keep the stage
    // available while the research surface is already showing.
    "web-research": (state.stage === "web-research" || state.presentationRequirements.status === "confirmed")
      && (state.presentationRequirements.research.web.enabled === true || state.presentationRequirements.research.images.enabled === true),
    outline:
      state.outline.length > 0 &&
      confirmedRequirementsAllowOutline(state.currentWorkspace?.requirements),
    generating: state.createDeckProgress !== null && (state.pageProgress?.pages.length ?? 0) > 0,
    deck: state.generated,
  };
  const previousStage = adjacentEnabledStage(state.stage, stageAvailability, -1);
  const nextStage = adjacentEnabledStage(state.stage, stageAvailability, 1);
  const browsePreviousStage = previousStage
    ? () => { void actions.navigateMain(previousStage); }
    : undefined;
  const browseNextStage = nextStage
    ? () => { void actions.navigateMain(nextStage); }
    : undefined;

  const format = slideFormat(state.currentWorkspace?.requirements.selections.aspect_ratio ?? state.selectedAspectRatio);
  const showManualEditor = manualEditorOpen && Boolean(state.currentWorkspace?.workspace_dir) && manualEditorPages.length > 0;
  const showPageRegeneration = pageRegeneration.view === "configure" || pageRegeneration.view === "candidates";

  return (
    <SlideAspectRatioContext.Provider value={format.aspectRatio}><div className="ppt-app-root" style={{ "--slide-aspect": format.width / format.height } as CSSProperties}>
      {pageRegeneration.view === "configure" ? <PageRegenerationSetupPage model={pageRegeneration} t={t} /> : null}
      {pageRegeneration.view === "candidates" ? <PageRegenerationPage key={pageRegeneration.batch?.id} model={pageRegeneration} t={t} /> : null}
      {showManualEditor && !showPageRegeneration ? (
      <ManualPageEditorShell
        t={t}
        workspaceDir={state.currentWorkspace!.workspace_dir}
        pages={manualEditorPages}
        initialPageIndex={state.currentSlide}
        onPageUpdated={actions.applyManualPageUpdate}
        onExit={async (workspaceDir, pageId, requiresDeckRender) => {
          setManualEditorOpen(false);
          await actions.exitManualEditor(workspaceDir, pageId, requiresDeckRender);
        }}
      />
      ) : null}
    <main className="slideforge-stage" style={{ display: showManualEditor || showPageRegeneration ? "none" : undefined }}>
      <button
        data-performance-id="app.panel.open"
        className={`launcher-btn ${state.panelMode === "closed" ? "visible" : ""}`}
        onClick={() => actions.setPanelMode("visible")}
        aria-label={t.appName}
      >
        <Presentation size={24} aria-hidden="true" />
      </button>

      <button
        data-performance-id="app.panel.restore"
        className={`minimized-pill ${state.panelMode === "minimized" ? "visible" : ""}`}
        onClick={() => actions.setPanelMode("visible")}
      >
        <Presentation size={20} aria-hidden="true" />
        <span>
          {t.appName}
          {state.currentStatus ? <small> · {state.currentStatus}</small> : null}
        </span>
      </button>

      <section className={`deck-panel ${state.panelMode === "visible" ? "visible" : ""}`}>
        <div className={`toast ${state.toast ? "visible" : ""}`}>{state.toast}</div>

        <ConfirmationDialog
          request={state.confirmationDialog}
          onResolve={actions.resolveConfirmation}
        />

        <CloudSyncNoticeDialog
          t={t}
          notice={state.cloudConflictDialog}
          onDismiss={actions.dismissCloudConflictDialog}
        />

        {state.stage === "generating" && state.generationViewState.isStopping ? (
          <StoppingGenerationOverlay t={t} />
        ) : null}

        {showEntrySidebar || showBatchTestingPage || showWebResearchLabPage ? null : (
          <PanelHeader
            t={t}
            locale={locale}
            setLocale={setLocale}
            status={state.currentStatus}
            onLibrary={() => void actions.navigateFromHeader("settings")}
            navigationDisabled={state.stage === "generating" && state.generationViewState.navigationLocked}
            onHome={() => void actions.goHomeFromHeader()}
          />
        )}
        <div className={`entry-layout ${showEntrySidebar ? "with-sidebar" : ""}`}>
          {showEntrySidebar ? (
            <EntrySidebar
              t={t}
              page={state.page}
              collapsed={entrySidebarCollapsed}
              onToggleCollapsed={() => setEntrySidebarCollapsed((collapsed) => !collapsed)}
              onHome={() => void actions.goHomeFromHeader()}
              onMyWork={() => void actions.navigateFromHeader("my-work")}
              onMyTemplates={() => void actions.navigateFromHeader("my-templates")}
              batchTestingEnabled={state.batchTesting.enabled}
              onBatchTesting={() => void actions.openBatchTesting()}
              webResearchLabEnabled={state.webResearchLab.enabled}
              onWebResearchLab={() => void actions.openWebResearchLab()}
            />
          ) : null}
          <div className="entry-main">
          {showEntrySidebar ? (
            <EntryTopControls
              t={t}
              locale={locale}
              setLocale={setLocale}
              onSettings={() => void actions.navigateFromHeader("settings")}
            />
          ) : null}
          {showProgressLine ? (
            <ProgressLine
              stage={state.stage}
              t={t}
              requirementsEnabled={stageAvailability.requirements}
              webResearchEnabled={stageAvailability["web-research"]}
              outlineEnabled={stageAvailability.outline}
              generatingEnabled={stageAvailability.generating}
              generationInFlight={
                state.generationViewState.status === "preparing" ||
                state.generationViewState.isActive
              }
              deckEnabled={stageAvailability.deck}
              onNavigate={actions.navigateMain}
            />
          ) : null}

          <div className={`view-container ${showBatchTestingPage ? "batch-testing-view-container" : ""} ${(state.page === "main" || state.page === "export") && state.stage === "deck" ? "deck-result-view" : ""}`}>
          {state.page === "main" && state.stage === "brief" ? (
            <BriefPage
              t={t}
              prompt={state.prompt}
              aspectRatio={state.selectedAspectRatio}
              onAspectRatioChange={actions.setSelectedAspectRatio}
              aspectRatioLocked={Boolean((state.currentWorkspace?.outline as { items?: { page_id?: string }[] } | undefined)?.items?.some((page) => page.page_id))}
              setPrompt={actions.setPrompt}
              loading={state.loading}
              generateDeck={actions.generatePresentationRequirements}
              visualStylePresets={[...VISUAL_STYLE_PRESETS, ...state.userTemplates.presets]}
              selectedVisualStylePresetId={state.selectedVisualStylePresetId}
              onSelectVisualStylePreset={actions.selectVisualStylePreset}
              uploadedSources={state.uploadedSources}
              uploadedSourcePreflights={state.uploadedSourcePreflights}
              uploadUploadedSource={actions.uploadUploadedSource}
              removeUploadedSource={actions.removeUploadedSource}
              onForward={browseNextStage}
              onManageUserTemplates={() => void actions.navigateFromHeader("my-templates")}
            />
          ) : null}

          {state.page === "main" && state.stage === "requirements" ? (
            <PresentationRequirementsPage
              t={t}
              brief={state.presentationRequirements.source?.brief ?? state.prompt}
              requirements={state.presentationRequirements}
              status={state.requirementsStatus}
              error={state.requirementsErrorDetail
                ? summarizeUserFacingError(t, state.requirementsErrorDetail, t.requirements.errorBody).summary
                : state.requirementsError}
              errorDetail={state.requirementsErrorDetail}
              saving={state.requirementsSaving}
              confirming={state.requirementsConfirming}
              dirty={state.requirementsDirty}
              hasSavedDraft={state.requirementsHasSavedDraft}
              progress={state.requirementsProgress}
              visualStylePresets={[...VISUAL_STYLE_PRESETS, ...state.userTemplates.presets]}
              onSelect={actions.selectPresentationRequirement}
              onSelectResearch={actions.selectPresentationResearch}
              onRetry={() => void actions.retryPresentationRequirements()}
              onManual={() => void actions.useManualPresentationRequirements()}
              onBack={browsePreviousStage ?? (() => undefined)}
              onForward={browseNextStage}
              onSave={() => void actions.savePresentationRequirements()}
              onConfirm={() => void actions.confirmPresentationRequirements()}
            />
          ) : null}

          {state.page === "main" && state.stage === "web-research" ? (
            <WebResearchPage
              t={t}
              status={state.webResearchStatus}
              error={state.webResearchError}
              errorDetail={state.webResearchErrorDetail}
              progress={state.webResearchProgress}
              onRetry={() => void actions.retryWebResearch()}
              onBack={actions.returnToRequirementsFromWebResearch}
            />
          ) : null}

          {state.page === "main" && state.stage === "outline" ? (
            <OutlinePage
              t={t}
              progress={state.outlineCreationProgress}
              workspaceKey={state.currentWorkspace?.workspace_dir ?? ""}
              pageImageSearch={actions.pageImageSearch}
              imageLibrary={actions.imageLibrary}
              imageUpload={actions.pageImageUpload}
              loadImages={actions.loadOutlineImages}
              loadImagePreview={actions.loadOutlineImagePreview}
              title={state.outlineDraftTitle}
              globalRequirements={state.outlineDraftRequirements}
              setGlobalRequirements={actions.setOutlineDraftRequirements}
              outline={state.outlineDraft}
              dirty={state.outlineDirty}
              saving={state.outlineSaving}
              error={state.outlineError}
              errorDetail={state.outlineErrorDetail}
              setTitle={actions.setOutlineDraftTitle}
              replaceItems={actions.replaceOutlineDraftItems}
              feedback={state.outlineFeedback}
              setFeedback={actions.setOutlineFeedback}
              applyFeedback={actions.applyOutlineFeedback}
              save={actions.saveOutlineDraft}
              retry={actions.retryOutlineCreation}
              backToRequirements={browsePreviousStage ?? (() => undefined)}
              forward={browseNextStage}
              confirm={actions.createDeckFromOutline}
              loading={state.loading}
            />
          ) : null}

          {state.page === "main" && state.stage === "generating" ? (
            <GeneratingPage
              previewWorkspaceDir={state.generationPreviewWorkspaceDir}
              t={t}
              viewState={state.generationViewState}
              progress={state.createDeckProgress}
              history={state.generationHistory}
              pagePreviews={state.generationPagePreviews}
              pinnedPreviewPageId={state.pinnedGenerationPreviewPageId}
              onSelectPreviewPage={actions.selectGenerationPreviewPage}
              onBack={browsePreviousStage ?? (() => undefined)}
              onForward={browseNextStage}
              onBackToOutline={actions.returnToOutlineFromGeneration}
              onStop={() => void actions.cancelGenerateDeck()}
              onResume={actions.resumeDeckGeneration}
              canBackToOutline={state.outline.length > 0}
            />
          ) : null}

          {(state.page === "main" && state.stage === "deck") || (state.generated && state.currentWorkspace && state.page !== "my-work") ? (
            <div key={state.currentWorkspace?.workspace_dir ?? "deck"}
              style={{ display: (state.page === "main" || state.page === "export") && state.stage === "deck" ? "contents" : "none" }}>
            <DeckPage
              recoveryEnabled={state.page === "main" && state.stage === "deck" && !manualEditorOpen && !state.confirmationDialog}
              onPageRestored={actions.applyManualPageUpdate}
              t={t}
              deck={state.deck}
              currentSlide={state.currentSlide}
              setCurrentSlide={actions.setCurrentSlide}
              reviewRender={state.reviewRender}
              loading={state.loading}
              onPreview={() => actions.navigate("review")}
              onBack={browsePreviousStage ?? (() => undefined)}
              onRegeneratePage={() => void pageRegeneration.open(state.currentSlide)}
              onBeautifyPage={() => void pageRegeneration.open(state.currentSlide, "beautify")}
              canRegeneratePage={pageRegeneration.available}
              onRefineSlide={(instruction) => void actions.refineSlide(instruction)}
              onRefineDeck={actions.openRefineDeck}
              onExport={() => actions.navigate("export")}
              onEdit={() => setManualEditorOpen(true)}
            />
            </div>
          ) : null}

          {state.page === "my-templates" ? <UserTemplatesPage t={t} model={state.userTemplates} /> : null}
          {state.page === "my-work" ? (
            <MyWorkPage
              t={t}
              locale={locale}
              workspaceScan={state.workspaceScan}
              syncStates={state.workspaceSyncStates}
              cloudWorkspaces={state.cloudWorkspaces}
              loading={state.workspaceLoading}
              openingWorkspaceDir={state.openingWorkspaceDir}
              highlightedWorkspaceId={state.highlightedWorkspaceId}
              error={state.workspaceError}
              errorDetail={state.workspaceErrorDetail}
              onRetry={() => actions.refreshMyWork({ force: true })}
              onOpen={actions.openWorkspace}
              onNew={actions.startNewPresentation}
              onRename={actions.renameWorkspace}
              onDelete={actions.deleteWorkspace}
              onDuplicate={actions.duplicateWorkspace}
            />
          ) : null}

          {state.page === "batch-testing" ? (
            <BatchTestingPage
              t={t}
              locale={locale}
              setLocale={setLocale}
              state={state.batchTesting}
              onExit={actions.exitBatchTesting}
              onHistory={actions.showBatchTestHistory}
              onNew={actions.showNewBatchTest}
              onRefresh={actions.refreshBatchTestHistory}
              onOpenRun={actions.openBatchTestRun}
              onDeleteRun={actions.deleteBatchTestRun}
              onLoadCase={actions.loadBatchTestCaseDetail}
              onStart={actions.startBatchTest}
              onStop={actions.stopBatchTest}
              onDownload={actions.downloadBatchTestBundle}
            />
          ) : null}

          {state.page === "web-research-lab" ? (
            <WebResearchLabPage
              t={t}
              locale={locale}
              setLocale={setLocale}
              state={state.webResearchLab}
              onExit={actions.exitWebResearchLab}
              onRun={actions.runWebResearchLab}
              onStop={actions.stopWebResearchLab}
            />
          ) : null}

          {state.page === "settings" ? (
            <LibraryPage
              t={t}
              locale={locale}
              settings={state.globalSettings}
              currentWorkspace={state.templateDiagnosticMode ? null : state.currentWorkspace}
              diagnosticTemplate={state.templateDiagnosticMode ? {
                templates: state.userTemplates.templates,
                selectedId: state.userTemplates.selectedId,
                select: (id) => { actions.resetWorkspaceDiagnosticBundle(); state.userTemplates.select(id); },
              } : undefined}
              loading={state.workspaceLoading}
              savingSettings={state.workspaceSettingsSaving}
              runtimeInfo={state.runtimeInfo}
              runtimeInfoError={state.runtimeInfoError}
              agentResourceInfo={state.agentResourceInfo}
              snapshotInfo={state.workspaceSnapshotInfo}
              snapshotSyncState={state.workspaceSnapshotSyncState}
              onRefreshSnapshotInfo={actions.refreshWorkspaceSnapshotInfo}
              onBack={actions.goBack}
              onSaveSettings={actions.saveWorkspaceSettings}
              onSaveTitle={actions.saveWorkspaceTitle}
              workspaceDiagnosticBundleEnabled={state.workspaceDiagnosticBundleEnabled}
              workspaceDiagnosticBundle={state.workspaceDiagnosticBundle}
              onDownloadWorkspaceDiagnosticBundle={actions.downloadWorkspaceDiagnosticBundle}
              onResetWorkspaceDiagnosticBundle={actions.resetWorkspaceDiagnosticBundle}
              performanceTesting={state.performanceTesting}
              onRefreshPerformanceRuns={actions.refreshPerformanceRuns}
              onRefreshAgentResourceInfo={actions.refreshAgentResourceInfo}
              onStartPerformanceRun={actions.startPerformanceRun}
              onFinalizePerformanceRun={actions.finalizePerformanceRun}
              onAbandonPerformanceRun={actions.abandonPerformanceRun}
              onViewPerformanceReport={actions.openPerformanceReport}
              onRegeneratePerformanceReport={actions.regeneratePerformanceReport}
              onDeletePerformanceRun={actions.deletePerformanceRun}
            />
          ) : null}

          {state.page === "performance-report" ? (
            <PerformanceReportPage
              t={t}
              html={state.performanceTesting.reportHtml}
              runId={state.performanceTesting.reportRunId}
              onBack={() => void actions.goBack()}
            />
          ) : null}

          {state.page === "review" ? (
            <ReviewPage
              recoveryEnabled={!manualEditorOpen && !state.confirmationDialog}
              onPageRestored={actions.applyManualPageUpdate}
              t={t}
              deck={state.deck}
              currentSlide={state.currentSlide}
              setCurrentSlide={actions.setCurrentSlide}
              previewMode={state.previewMode}
              setPreviewMode={actions.setPreviewMode}
              reviewRender={state.reviewRender}
              renderDeckHtml={actions.renderDeckHtml}
              refreshPageImage={actions.refreshReviewPageImage}
              onBack={actions.goBack}
              onEdit={() => setManualEditorOpen(true)}
            />
          ) : null}

          {state.page === "refine" && refineSlide ? (
            <RefinePage
              onPageRestored={actions.applyManualPageUpdate}
              t={t}
              deck={state.deck}
              slide={refineSlide}
              slideIndex={refineSlideIndex}
              slideNumber={String(refineSlideIndex + 1)}
              refineScope={state.refineScope}
              reviewRender={state.reviewRender}
              loading={state.loading}
              onBack={actions.goBack}
              onRefineDeck={(instruction) => void actions.refineDeck(instruction)}
              onRefineSlide={(instruction) => void actions.refineSlide(instruction)}
            />
          ) : null}

          {state.page === "export" ? (
            <ExportPage
              t={t}
              progress={state.exportProgress}
              artifact={state.exportArtifact}
              download={state.exportDownload}
              loading={state.loading}
              totalPages={state.deck.length}
              onBack={actions.goBack}
              onExport={actions.exportFile}
              onDownload={actions.downloadExportArtifact}
            />
          ) : null}

          </div>
          </div>
        </div>
      </section>
    </main>
    </div></SlideAspectRatioContext.Provider>
  );
}
