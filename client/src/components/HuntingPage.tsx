import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  Coins,
  Download,
  Eye,
  FileText,
  History,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  MonitorSmartphone,
  Paperclip,
  PencilLine,
  Radar,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Upload,
  Undo2,
  X,
} from "lucide-react";
import HoloPanel from "./HoloPanel";
import { useStreamEvent } from "../hooks/useStreamEvent";
import { ATTACHMENT_ACCEPT, useAttachmentDrop } from "../hooks/useAttachmentDrop";
import {
  activeApplicationConflict,
  api,
  type CanonicalCv,
  type CvRevision,
  type HuntingApplication,
  type HuntingApplicationAttempt,
  type HuntingApplicationUsage,
  type HuntingDiscoveryRun,
  type HuntingJob,
  type HuntingJobScope,
  type JobSearchProfile,
  type StoredAttachment,
} from "../lib/api";

// Statuses where J.A.R.V.I.S. still owns the run; the card stays busy and non-resumable.
const ACTIVE_APPLICATION_STATUSES = new Set<HuntingApplication["status"]>([
  "queued",
  "preparing_cv",
  "opening_form",
  "uploading_cv",
  "filling_verified_fields",
]);

type Notice = { kind: "success" | "error" | "info"; text: string };
type CvDraftSnapshot = {
  content: string;
  sourceName: string | null;
  sourceFormat: string | null;
  sourcePdfToken: string | null;
};

// Deliberately generic: the server scopes the grant to whatever policy the checkpoint named, so
// one button works for a privacy policy, terms, or a declaration without ever widening the grant.
const CONSENT_GRANT_PHRASE = "Accept it on my behalf and continue.";

const CvPdfPreview = lazy(() => import("./CvPdfPreview"));
const BrowserTakeover = lazy(() => import("./BrowserTakeover"));

export default function HuntingPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const pdfUrl = useRef<string | null>(null);
  const [savedCv, setSavedCv] = useState<CanonicalCv | null>(null);
  const [content, setContent] = useState("");
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [sourceFormat, setSourceFormat] = useState<string | null>(null);
  const [sourcePdfToken, setSourcePdfToken] = useState<string | null>(null);
  const [savedProfile, setSavedProfile] = useState<JobSearchProfile | null>(null);
  const [jobQuery, setJobQuery] = useState("");
  const [jobLocations, setJobLocations] = useState("");
  const [workMode, setWorkMode] = useState("any");
  const [jobType, setJobType] = useState("permanent");
  const [minimumSalary, setMinimumSalary] = useState("");
  const [excludedKeywords, setExcludedKeywords] = useState("");
  const [jobs, setJobs] = useState<HuntingJob[]>([]);
  const [jobScope, setJobScope] = useState<HuntingJobScope>("current");
  const [discoveryRun, setDiscoveryRun] = useState<HuntingDiscoveryRun | null>(null);
  const [applications, setApplications] = useState<HuntingApplication[]>([]);
  // Open browser mirror: targetId null means "let me pick a tab" (a hunt's blocked search
  // page has no checkpoint of its own).
  const [takeover, setTakeover] = useState<{
    targetId: string | null;
    url: string | null;
    jobId: string | null;
  } | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revising, setRevising] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [updatingJobId, setUpdatingJobId] = useState<string | null>(null);
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const cancelledApplicationIds = useRef(new Set<string>());
  const [cvView, setCvView] = useState<"edit" | "preview">("edit");
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [previewingPdf, setPreviewingPdf] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [draftUndo, setDraftUndo] = useState<CvDraftSnapshot | null>(null);
  const [pdfPreviewError, setPdfPreviewError] = useState<string | null>(null);
  const [pdfPreviewSource, setPdfPreviewSource] = useState<"original" | "template" | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.cv(), api.huntingSearchProfile(), api.huntingJobs(jobScope), api.huntingApplications()])
      .then(([cvResponse, profileResponse, jobsResponse, applicationsResponse]) => {
        if (cancelled) return;
        const cv = cvResponse.cv;
        if (cv) {
          setSavedCv(cv);
          setContent(cv.content);
          setSourceName(cv.sourceName);
          setSourceFormat(cv.sourceFormat);
        }
        const profile = profileResponse.profile;
        if (profile) {
          setSavedProfile(profile);
          setJobQuery(profile.query);
          setJobLocations(profile.locations.join(", "));
          setWorkMode(profile.workModes[0] ?? "any");
          setJobType(profile.jobTypes[0] ?? "any");
          setMinimumSalary(profile.minimumSalary === null ? "" : String(profile.minimumSalary));
          setExcludedKeywords(profile.excludedKeywords.join(", "));
        }
        setJobs(jobsResponse.jobs);
        setDiscoveryRun(jobsResponse.run);
        setApplications(applicationsResponse.applications);
      })
      .catch((error) => {
        if (!cancelled) setNotice({ kind: "error", text: errorMessage(error) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (pdfUrl.current) URL.revokeObjectURL(pdfUrl.current);
  }, []);

  useStreamEvent("hunting.applications.changed", () => {
    api.huntingApplications()
      .then((response) => setApplications(response.applications))
      .catch(() => undefined);
  });

  const dirty =
    content !== (savedCv?.content ?? "") ||
    sourceName !== (savedCv?.sourceName ?? null) ||
    sourceFormat !== (savedCv?.sourceFormat ?? null) ||
    sourcePdfToken !== null;
  const words = useMemo(() => content.trim().split(/\s+/).filter(Boolean).length, [content]);
  const profileDraft = useMemo(
    () => ({
      query: jobQuery.trim(),
      locations: commaList(jobLocations),
      workModes: workMode === "any" ? [] : [workMode],
      minimumSalary: minimumSalary ? Number(minimumSalary) : null,
      salaryCurrency: "GBP",
      jobTypes: jobType === "any" ? [] : [jobType],
      excludedKeywords: commaList(excludedKeywords),
    }),
    [excludedKeywords, jobLocations, jobQuery, jobType, minimumSalary, workMode],
  );
  const profileDirty = JSON.stringify(profileDraft) !== JSON.stringify(savedProfile ? {
    query: savedProfile.query,
    locations: savedProfile.locations,
    workModes: savedProfile.workModes,
    minimumSalary: savedProfile.minimumSalary,
    salaryCurrency: savedProfile.salaryCurrency,
    jobTypes: savedProfile.jobTypes,
    excludedKeywords: savedProfile.excludedKeywords,
  } : {
    query: "",
    locations: [],
    workModes: [],
    minimumSalary: null,
    salaryCurrency: "GBP",
    jobTypes: ["permanent"],
    excludedKeywords: [],
  });
  const visibleJobs = showDismissed ? jobs : jobs.filter((job) => job.status !== "dismissed");
  const applicationByJob = useMemo(
    () => new Map(applications.map((application) => [application.jobId, application])),
    [applications],
  );

  async function persistSearchProfile() {
    const response = await api.saveHuntingSearchProfile({
      ...profileDraft,
      expectedVersion: savedProfile?.version ?? 0,
    });
    setSavedProfile(response.profile);
    return response.profile;
  }

  async function saveSearchProfile() {
    if (jobQuery.trim().length < 10 || savingProfile) return;
    setSavingProfile(true);
    setNotice(null);
    try {
      await persistSearchProfile();
      setNotice({ kind: "success", text: "Job-search brief saved privately in ORION." });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setSavingProfile(false);
    }
  }

  async function discoverJobs() {
    if (jobQuery.trim().length < 10 || discovering) return;
    setDiscovering(true);
    setNotice(null);
    try {
      if (profileDirty) await persistSearchProfile();
      const response = await api.discoverHuntingJobs();
      setJobs(response.jobs);
      setJobScope("run");
      setDiscoveryRun(response.run);
      const unavailable = response.sourceStatus.filter((entry) => entry.status === "unavailable");
      setNotice({
        kind: "success",
        text: `${response.summary} ${response.run.newCount} new, ${response.run.observedCount} listings observed in this run.${
          unavailable.length ? ` No results from: ${unavailable.map((entry) => entry.source).join(", ")}.` : ""
        }`,
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setDiscovering(false);
    }
  }

  async function changeJobScope(scope: HuntingJobScope) {
    setJobScope(scope);
    try {
      const response = await api.huntingJobs(scope);
      setJobs(response.jobs);
      setDiscoveryRun(response.run);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  async function updateJobStatus(job: HuntingJob, status: HuntingJob["status"]) {
    if (updatingJobId) return;
    setUpdatingJobId(job.id);
    try {
      const response = await api.setHuntingJobStatus(job.id, status);
      setJobs((current) => current.map((entry) => entry.id === job.id ? response.job : entry));
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setUpdatingJobId(null);
    }
  }

  async function runApplication(job: HuntingJob, resume = false, guidance = "", attachmentIds: string[] = []) {
    if (applyingJobId) return false;
    if (!savedCv || dirty) {
      setNotice({ kind: "error", text: "Save the current CV before J.A.R.V.I.S. starts an application." });
      return false;
    }
    setApplyingJobId(job.id);
    setNotice({
      kind: "info",
      text: resume
        ? `J.A.R.V.I.S. is resuming the ${job.company} application.`
        : `J.A.R.V.I.S. is tailoring the CV and opening ${job.company}.`,
    });
    try {
      const response = await api.runHuntingApplication(job.id, resume, guidance, attachmentIds);
      if (cancelledApplicationIds.current.has(job.id)) return false;
      setApplications((current) => [
        response.application,
        ...current.filter((application) => application.jobId !== job.id),
      ]);
      setNotice({
        kind: response.application.status === "failed" ? "error" : "success",
        text: response.application.summary,
      });
      return true;
    } catch (error) {
      if (cancelledApplicationIds.current.has(job.id)) return false;
      // Only one application runs at a time. When another job holds the slot, name it and let
      // the user swap rather than leaving them with a refusal they cannot act on.
      const conflict = activeApplicationConflict(error);
      if (conflict && !conflict.isSameJob) {
        setApplyingJobId(null);
        const swap = window.confirm(
          `J.A.R.V.I.S. is currently applying to ${conflict.company} — ${conflict.title}.\n\n` +
            `Cancel that application and start ${job.company} — ${job.title} instead?`,
        );
        if (!swap) {
          setNotice({ kind: "info", text: `Left the ${conflict.company} application running.` });
          return false;
        }
        const stopped = await cancelApplication({ id: conflict.jobId, company: conflict.company });
        if (!stopped) return false;
        return await runApplication(job, resume, guidance, attachmentIds);
      }
      if (conflict?.isSameJob) {
        setNotice({
          kind: "info",
          text: `J.A.R.V.I.S. is already working on ${job.company}. Use Cancel on that card to stop it.`,
        });
        return false;
      }
      setNotice({ kind: "error", text: errorMessage(error) });
      try {
        const response = await api.huntingApplications();
        setApplications(response.applications);
      } catch {
        // Preserve the original application failure in the UI.
      }
      return false;
    } finally {
      cancelledApplicationIds.current.delete(job.id);
      setApplyingJobId(null);
    }
  }

  /** Returns whether the run actually stopped, so a caller can swap to another job. */
  async function cancelApplication(job: { id: string; company: string }): Promise<boolean> {
    if (cancellingJobId) return false;
    cancelledApplicationIds.current.add(job.id);
    setCancellingJobId(job.id);
    setNotice({ kind: "info", text: `Stopping the ${job.company} application…` });
    setApplications((current) =>
      current.map((application) =>
        application.jobId === job.id
          ? {
              ...application,
              status: "failed",
              reasonCode: "user_cancelled",
              summary: "Application automation was cancelled by the user. Any active work is stopping.",
              manualAction: null,
              manualActionKind: null,
            }
          : application,
      ),
    );
    try {
      const response = await api.cancelHuntingApplication(job.id);
      setApplications((current) => [
        response.application,
        ...current.filter((application) => application.jobId !== job.id),
      ]);
      setApplyingJobId(null);
      setNotice({ kind: "success", text: response.application.summary });
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: `Cancellation could not be confirmed: ${errorMessage(error)}` });
      return false;
    } finally {
      setCancellingJobId(null);
    }
  }

  async function markApplicationSubmitted(jobId: string, manualRecoveryConfirmed = false) {
    if (applyingJobId) return;
    setApplyingJobId(jobId);
    try {
      const response = await api.markHuntingApplicationSubmitted(jobId, manualRecoveryConfirmed);
      setApplications((current) => [
        response.application,
        ...current.filter((application) => application.jobId !== jobId),
      ]);
      setNotice({
        kind: response.application.status === "submitted" ? "success" : "error",
        text: response.application.summary,
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setApplyingJobId(null);
    }
  }

  async function submitApplicationWithJarvis(jobId: string) {
    if (applyingJobId) return;
    setApplyingJobId(jobId);
    try {
      const response = await api.submitHuntingApplication(jobId);
      setApplications((current) => [
        response.application,
        ...current.filter((application) => application.jobId !== jobId),
      ]);
      setNotice({
        kind: response.application.status === "submitted" ? "success" : "error",
        text: response.application.summary,
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setApplyingJobId(null);
    }
  }

  async function upload(file: File) {
    if (dirty && !window.confirm("Replace the current unsaved CV draft with this file?")) return;
    setUploading(true);
    setNotice(null);
    setWarnings([]);
    try {
      const data = await fileAsBase64(file);
      const response = await api.uploadCv({ name: file.name, type: file.type, data });
      setContent(response.document.content);
      setSourceName(response.document.sourceName);
      setSourceFormat(response.document.sourceFormat);
      setSourcePdfToken(response.document.sourcePdfToken);
      setDraftUndo(null);
      showCvEditor();
      setNotice({
        kind: "info",
        text: response.document.sourcePdfToken
          ? "Original PDF imported with its exact styling. Review it, then save."
          : "CV imported as an unsaved draft. Review it, then save.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function save() {
    if (content.trim().length < 40 || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await api.saveCv({
        content,
        sourceName,
        sourceFormat,
        sourcePdfToken,
        expectedVersion: savedCv?.version ?? 0,
      });
      setSavedCv(response.cv);
      setContent(response.cv.content);
      setSourcePdfToken(null);
      setDraftUndo(null);
      setNotice({ kind: "success", text: "Canonical CV saved privately in ORION." });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  async function revise() {
    if (!instruction.trim() || content.trim().length < 40 || revising) return;
    setRevising(true);
    setNotice(null);
    setWarnings([]);
    try {
      const previousDraft = { content, sourceName, sourceFormat, sourcePdfToken };
      const response = await api.reviseCv(
        content,
        instruction.trim(),
        sourceName,
        sourcePdfToken,
      );
      applyRevision(response.revision, previousDraft);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setRevising(false);
    }
  }

  function applyRevision(revision: CvRevision, previousDraft: CvDraftSnapshot) {
    setDraftUndo(previousDraft);
    setContent(revision.content);
    setSourcePdfToken(revision.sourcePdfToken);
    showCvEditor();
    setWarnings(revision.warnings);
    setNotice({
      kind: "success",
      text: revision.preservedPdfStyling
        ? `${revision.summary} The locked CV styling is preserved. Open PDF preview, then save.`
        : `${revision.summary} Review the PDF preview before saving.`,
    });
  }

  async function goBack() {
    if (undoing) return;
    if (draftUndo) {
      setContent(draftUndo.content);
      setSourceName(draftUndo.sourceName);
      setSourceFormat(draftUndo.sourceFormat);
      setSourcePdfToken(draftUndo.sourcePdfToken);
      setDraftUndo(null);
      setWarnings([]);
      showCvEditor();
      setNotice({ kind: "success", text: "The latest unsaved CV edit was reverted." });
      return;
    }
    if (dirty || !savedCv?.canUndo) return;
    setUndoing(true);
    setNotice(null);
    try {
      const response = await api.undoCv(savedCv.version);
      setSavedCv(response.cv);
      setContent(response.cv.content);
      setSourceName(response.cv.sourceName);
      setSourceFormat(response.cv.sourceFormat);
      setSourcePdfToken(null);
      setWarnings([]);
      showCvEditor();
      setNotice({ kind: "success", text: "The previous saved CV version was restored." });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setUndoing(false);
    }
  }

  async function proposeMemory() {
    if (!savedCv || dirty || proposing) return;
    setProposing(true);
    setNotice(null);
    try {
      const response = await api.proposeCvMemory();
      setNotice({
        kind: "success",
        text: response.created
          ? "Professional facts were staged for approval in Memory. Nothing was saved automatically."
          : "This CV version already has a memory proposal.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setProposing(false);
    }
  }

  function discard() {
    setContent(savedCv?.content ?? "");
    setSourceName(savedCv?.sourceName ?? null);
    setSourceFormat(savedCv?.sourceFormat ?? null);
    setSourcePdfToken(null);
    setWarnings([]);
    setDraftUndo(null);
    setNotice(null);
    showCvEditor();
  }

  function download() {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    link.download = "Example-User-CV.md";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function clearPdfPreview() {
    if (pdfUrl.current) URL.revokeObjectURL(pdfUrl.current);
    pdfUrl.current = null;
    setPdfPreviewUrl(null);
    setPdfPreviewError(null);
    setPdfPreviewSource(null);
  }

  function showCvEditor() {
    clearPdfPreview();
    setCvView("edit");
  }

  function changeCvContent(value: string) {
    clearPdfPreview();
    setContent(value);
  }

  async function showPdfPreview() {
    setCvView("preview");
    await refreshPdfPreview();
  }

  async function refreshPdfPreview() {
    if (content.trim().length < 40 || previewingPdf) return;
    setPreviewingPdf(true);
    setPdfPreviewError(null);
    try {
      const preview = await api.previewCvPdf(content, sourceName, sourcePdfToken);
      clearPdfPreview();
      const url = URL.createObjectURL(preview.blob);
      pdfUrl.current = url;
      setPdfPreviewUrl(url);
      setPdfPreviewSource(preview.source);
    } catch (error) {
      setPdfPreviewError(errorMessage(error));
    } finally {
      setPreviewingPdf(false);
    }
  }

  async function downloadPdf() {
    if (content.trim().length < 40 || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const preview = await api.previewCvPdf(content, sourceName, sourcePdfToken);
      downloadBlob(preview.blob, "Example-User-CV.pdf");
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setDownloadingPdf(false);
    }
  }

  return (
    <section className="hunting-page">
      <header className="hunting-header">
        <div>
          <h1>Hunting</h1>
          <p>Career search command centre · controlled applications, verified personal data</p>
        </div>
        <div className="hunting-header__guard">
          <ShieldCheck size={17} />
          <span>Human review before CAPTCHA or submit</span>
        </div>
      </header>

      <div className="hunting-steps" aria-label="Hunting workflow">
        <WorkflowStep number="01" title="CV source" detail={savedCv ? "Ready" : "Optional"} active={Boolean(savedCv)} />
        <WorkflowStep number="02" title="Discover roles" detail={savedProfile ? "Configured" : "Set your brief"} active />
        <WorkflowStep number="03" title="Review & apply" detail="Human-gated" />
      </div>

      <div className="hunting-search-grid">
        <HoloPanel
          title="What should J.A.R.V.I.S. hunt for?"
          className="hunting-search-panel"
          right={<span className={profileDirty ? "hunting-dirty" : "hunting-synced"}>{profileDirty ? "Unsaved brief" : savedProfile ? "Brief saved" : "Not configured"}</span>}
        >
          <label className="hunting-field hunting-field--wide">
            <span>Describe the roles you want</span>
            <textarea
              value={jobQuery}
              onChange={(event) => setJobQuery(event.target.value)}
              placeholder="For example: Full-stack TypeScript or React software engineer roles in travel technology. Mid-level or senior, product-focused teams, permanent positions."
              maxLength={3000}
              aria-label="Jobs you are looking for"
            />
          </label>
          <div className="hunting-form-grid">
            <label className="hunting-field">
              <span>Locations</span>
              <input
                value={jobLocations}
                onChange={(event) => setJobLocations(event.target.value)}
                placeholder="London, Remote UK"
              />
            </label>
            <label className="hunting-field">
              <span>Minimum salary</span>
              <div className="hunting-salary-input"><b>£</b><input type="number" min="0" step="1000" value={minimumSalary} onChange={(event) => setMinimumSalary(event.target.value)} placeholder="55000" /></div>
            </label>
            <label className="hunting-field">
              <span>Work mode</span>
              <select value={workMode} onChange={(event) => setWorkMode(event.target.value)}>
                <option value="any">Any</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="onsite">On-site</option>
              </select>
            </label>
            <label className="hunting-field">
              <span>Employment</span>
              <select value={jobType} onChange={(event) => setJobType(event.target.value)}>
                <option value="any">Any</option>
                <option value="permanent">Permanent</option>
                <option value="contract">Contract</option>
                <option value="internship">Internship</option>
              </select>
            </label>
          </div>
          <label className="hunting-field hunting-field--wide">
            <span>Exclude <small>comma separated</small></span>
            <input value={excludedKeywords} onChange={(event) => setExcludedKeywords(event.target.value)} placeholder="unpaid, commission only, relocation required" />
          </label>
          <div className="hunting-search-actions">
            <p><ShieldCheck size={14} /> Discovery uses public listings only. Nothing is applied to automatically.</p>
            <div>
              <button className="hunting-plain-button" onClick={saveSearchProfile} disabled={!profileDirty || jobQuery.trim().length < 10 || savingProfile}>
                {savingProfile ? "Saving…" : "Save brief"}
              </button>
              <button className="btn-hud hunting-run-button" onClick={discoverJobs} disabled={jobQuery.trim().length < 10 || discovering}>
                {discovering ? <LoaderCircle className="hunting-spin" size={16} /> : <Radar size={16} />}
                {discovering ? "J.A.R.V.I.S. is searching" : "Start hunt"}
              </button>
            </div>
          </div>
        </HoloPanel>

        <HoloPanel
          title="Ranked opportunities"
          className="hunting-jobs-panel"
          right={
            <div className="hunting-jobs-filters">
              <button
                className="hunting-filter-button"
                onClick={() => setTakeover({ targetId: null, url: null, jobId: null })}
                title="Drive the browser J.A.R.V.I.S. uses — for a CAPTCHA or a sign-in it hit"
              >
                <MonitorSmartphone size={13} /> Browser
              </button>
              <button
                className="hunting-filter-button"
                onClick={() => void changeJobScope(jobScope === "all" ? "current" : "all")}
              >
                <History size={13} /> {jobScope === "all" ? "Current only" : "Show history"}
              </button>
              <button className="hunting-filter-button" onClick={() => setShowDismissed((current) => !current)}>
                {showDismissed ? "Hide dismissed" : "Show dismissed"}
              </button>
            </div>
          }
        >
          {discoveryRun ? (
            <div className="hunting-run-status">
              <span>
                <Radar size={12} /> Last hunt {formatTimestamp(discoveryRun.finishedAt ?? discoveryRun.startedAt)} ·{" "}
                {discoveryRun.newCount} new of {discoveryRun.observedCount} observed
              </span>
              {discoveryRun.sourceStatus.map((entry) => (
                <span
                  key={entry.source}
                  className={`hunting-source-chip hunting-source-chip--${entry.status}`}
                  title={entry.reason ?? `${entry.count} listing(s)`}
                >
                  {entry.source}: {entry.status === "covered" ? `${entry.count}` : "none"}
                </span>
              ))}
              {/* A source blocked by a challenge is something only the user can clear. */}
              {discoveryRun.sourceStatus.some((entry) => isChallengeReason(entry.reason)) ? (
                <button
                  className="hunting-filter-button"
                  onClick={() => setTakeover({ targetId: null, url: null, jobId: null })}
                >
                  <MonitorSmartphone size={12} /> Clear the challenge myself
                </button>
              ) : null}
            </div>
          ) : null}
          {discovering ? (
            <div className="hunting-jobs-empty"><Radar className="hunting-radar" size={30} /><b>Searching current listings…</b><span>J.A.R.V.I.S. is checking public sources and ranking factual matches.</span></div>
          ) : visibleJobs.length ? (
            <div className="hunting-job-list">
              {visibleJobs.map((job) => {
                const application = applicationByJob.get(job.id);
                const applicationBusy =
                  applyingJobId === job.id ||
                  (application ? ACTIVE_APPLICATION_STATUSES.has(application.status) : false);
                return (
                <article key={job.id} className={`hunting-job hunting-job--${job.status}`}>
                  <div className="hunting-job__score"><strong>{job.matchScore}</strong><small>match</small></div>
                  <div className="hunting-job__content">
                    <div className="hunting-job__heading">
                      <div><h3>{job.title}</h3><p><Building2 size={13} /> {job.company}</p></div>
                      {job.status === "shortlisted" ? <span><Star size={12} fill="currentColor" /> Shortlisted</span> : null}
                    </div>
                    <div className="hunting-job__meta">
                      <span className={`hunting-freshness hunting-freshness--${job.freshness}`} title={freshnessDetail(job)}>
                        {freshnessLabel(job.freshness)}
                      </span>
                      <span><MapPin size={12} /> {job.location}</span>
                      <span>{job.workMode ?? "mode unknown"}</span>
                      <span>{job.source}</span>
                      {job.listedAt ? <span><CalendarDays size={12} /> Posted {formatPostingDate(job.listedAt)}</span> : <span><CalendarDays size={12} /> Posting date unverified</span>}
                      {job.salary ? <span>{job.salary}</span> : null}
                    </div>
                    <p className="hunting-job__excerpt">{job.descriptionExcerpt}</p>
                    {job.matchReasons.length ? <ul>{job.matchReasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
                    <div className="hunting-job__actions">
                      <button
                        className="hunting-apply-button"
                        onClick={() => void runApplication(job, Boolean(application))}
                        disabled={applicationBusy || !savedCv || dirty || application?.status === "submitted"}
                      >
                        {applicationBusy ? <LoaderCircle className="hunting-spin" size={13} /> : <Sparkles size={13} />}
                        {applicationBusy
                          ? "J.A.R.V.I.S. applying"
                          : application?.status === "submitted"
                            ? "Submitted"
                            : application?.reasonCode === "user_cancelled"
                              ? "Apply again with J.A.R.V.I.S."
                              : application
                                ? "Resume with J.A.R.V.I.S."
                                : "Apply with J.A.R.V.I.S."}
                      </button>
                      {applicationBusy ? (
                        <button
                          className="hunting-cancel-button"
                          onClick={() => void cancelApplication(job)}
                          disabled={cancellingJobId === job.id}
                        >
                          {cancellingJobId === job.id
                            ? <LoaderCircle className="hunting-spin" size={13} />
                            : <X size={13} />}
                          {cancellingJobId === job.id ? "Stopping" : "Cancel"}
                        </button>
                      ) : null}
                      <button onClick={() => void updateJobStatus(job, job.status === "shortlisted" ? "new" : "shortlisted")} disabled={updatingJobId === job.id}><Star size={13} />{job.status === "shortlisted" ? "Unshortlist" : "Shortlist"}</button>
                      <button onClick={() => void updateJobStatus(job, "dismissed")} disabled={updatingJobId === job.id || job.status === "dismissed"}><X size={13} />Dismiss</button>
                      <a href={job.url} target="_blank" rel="noreferrer">Review listing <ArrowUpRight size={13} /></a>
                    </div>
                    {application ? (
                      <ApplicationCheckpoint
                        application={application}
                        busy={applicationBusy}
                        onResume={(guidance, attachmentIds) => runApplication(job, true, guidance, attachmentIds)}
                        onSubmitted={(manualRecoveryConfirmed) =>
                          void markApplicationSubmitted(job.id, manualRecoveryConfirmed)
                        }
                        onSubmitWithJarvis={() => void submitApplicationWithJarvis(job.id)}
                        onTakeover={() =>
                          setTakeover({
                            targetId: application.browserTargetId,
                            url: application.currentUrl || job.url,
                            jobId: job.id,
                          })
                        }
                      />
                    ) : null}
                  </div>
                </article>
                );
              })}
            </div>
          ) : (
            <div className="hunting-jobs-empty">
              <Search size={28} />
              <b>{jobScope === "all" ? "No opportunities yet" : "Nothing current in the queue"}</b>
              <span>
                {jobScope === "all"
                  ? "Save your brief and start a hunt. Results will appear here for review."
                  : "Start a hunt for fresh listings, or show history to see earlier and stale results."}
              </span>
            </div>
          )}
          <div className="hunting-jobs-guard"><BriefcaseBusiness size={14} /><span>J.A.R.V.I.S. fills verified fields and verifies your CV on the page. Sign-in, CAPTCHA, and uncertain answers remain yours; an explicit submit instruction authorizes one verified submission attempt.</span></div>
        </HoloPanel>
      </div>

      {notice ? <div className={`hunting-notice hunting-notice--${notice.kind}`}>{notice.kind === "success" ? <Check size={15} /> : notice.kind === "error" ? <AlertTriangle size={15} /> : <FileText size={15} />}<span>{notice.text}</span></div> : null}

      <div className="hunting-grid">
        <HoloPanel
          title="Canonical CV"
          className="hunting-editor-panel"
          right={<span className={dirty ? "hunting-dirty" : "hunting-synced"}>{dirty ? "Unsaved draft" : savedCv ? "Saved" : "Not configured"}</span>}
        >
          <div className="hunting-source-bar">
            <div>
              <FileText size={18} />
              <span>{sourceName ?? "No CV uploaded"}</span>
              {sourceFormat ? <small>{sourceFormat.toUpperCase()}</small> : null}
            </div>
            <button className="btn-hud hunting-compact-button" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <LoaderCircle className="hunting-spin" size={15} /> : <Upload size={15} />}
              {uploading ? "Importing" : "Upload"}
            </button>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </div>

          <div className="hunting-cv-tabs" role="tablist" aria-label="Canonical CV view">
            <button
              type="button"
              role="tab"
              aria-selected={cvView === "edit"}
              aria-controls="hunting-cv-editor-panel"
              className={cvView === "edit" ? "hunting-cv-tab hunting-cv-tab--active" : "hunting-cv-tab"}
              onClick={() => setCvView("edit")}
            >
              <PencilLine size={14} /> Edit CV
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={cvView === "preview"}
              aria-controls="hunting-cv-preview-panel"
              className={cvView === "preview" ? "hunting-cv-tab hunting-cv-tab--active" : "hunting-cv-tab"}
              onClick={() => void showPdfPreview()}
              disabled={content.trim().length < 40}
            >
              <Eye size={14} /> PDF preview
            </button>
            {cvView === "preview" ? (
              <div className="hunting-cv-preview-actions">
                {pdfPreviewSource ? (
                  <span className={`hunting-cv-preview-origin hunting-cv-preview-origin--${pdfPreviewSource}`}>
                    {pdfPreviewSource === "original" ? "Original styling" : "Locked template"}
                  </span>
                ) : null}
                <button type="button" onClick={() => void refreshPdfPreview()} disabled={previewingPdf}>
                  <RefreshCw className={previewingPdf ? "hunting-spin" : undefined} size={13} /> Refresh
                </button>
                {pdfPreviewUrl ? <a href={pdfPreviewUrl} download="Example-User-CV.pdf"><Download size={13} /> Download PDF</a> : null}
              </div>
            ) : null}
          </div>

          {loading ? (
            <div className="hunting-loading"><LoaderCircle className="hunting-spin" size={22} /> Loading private CV…</div>
          ) : cvView === "preview" ? (
            <div
              id="hunting-cv-preview-panel"
              className="hunting-cv-preview"
              role="tabpanel"
              aria-label="CV PDF preview"
            >
              {previewingPdf ? (
                <div className="hunting-cv-preview__state"><LoaderCircle className="hunting-spin" size={24} /><b>Rendering PDF preview…</b><span>Using the preserved PDF or the locked CV template for this draft.</span></div>
              ) : pdfPreviewError ? (
                <div className="hunting-cv-preview__state hunting-cv-preview__state--error"><AlertTriangle size={24} /><b>Preview unavailable</b><span>{pdfPreviewError}</span><button onClick={() => void refreshPdfPreview()}>Try again</button></div>
              ) : pdfPreviewUrl ? (
                <Suspense fallback={<div className="hunting-cv-preview__state"><LoaderCircle className="hunting-spin" size={24} /><b>Loading PDF viewer…</b></div>}>
                  <CvPdfPreview url={pdfPreviewUrl} />
                </Suspense>
              ) : (
                <div className="hunting-cv-preview__state"><FileText size={24} /><b>No preview yet</b><span>Open PDF preview to render the current CV draft.</span></div>
              )}
            </div>
          ) : (
            <textarea
              id="hunting-cv-editor-panel"
              className="hunting-cv-editor"
              value={content}
              onChange={(event) => changeCvContent(event.target.value)}
              placeholder="Upload a PDF, DOCX, Markdown, or text CV — or paste your CV here."
              spellCheck
              aria-label="CV content"
            />
          )}

          <div className="hunting-editor-footer">
            <span>{words.toLocaleString()} words · {content.length.toLocaleString()} characters</span>
            <div>
              <button
                className="hunting-plain-button hunting-back-button"
                onClick={() => void goBack()}
                disabled={undoing || (!draftUndo && (dirty || !savedCv?.canUndo))}
                title={draftUndo ? "Revert the latest draft edit" : "Restore the previous saved CV"}
              >
                {undoing ? <LoaderCircle className="hunting-spin" size={14} /> : <Undo2 size={14} />}
                Back
              </button>
              <button className="hunting-plain-button" onClick={discard} disabled={!dirty}>Discard</button>
              <button className="btn-hud hunting-save-button" onClick={save} disabled={!dirty || content.trim().length < 40 || saving}>
                {saving ? <LoaderCircle className="hunting-spin" size={16} /> : <Save size={16} />}
                {saving ? "Saving" : "Save canonical CV"}
              </button>
            </div>
          </div>
        </HoloPanel>

        <div className="hunting-side-column">
          <HoloPanel title="Prompt editor">
            <p className="hunting-panel-copy">J.A.R.V.I.S. uses OAuth GPT-5.6 Terra to prepare a factual draft. It cannot invent missing experience or sensitive details.</p>
            <textarea
              className="hunting-prompt"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="For example: tighten the summary for senior full-stack roles and make each bullet more outcome-focused."
              maxLength={4000}
              aria-label="CV edit instruction"
            />
            <button className="btn-hud hunting-revise-button" onClick={revise} disabled={!instruction.trim() || content.trim().length < 40 || revising}>
              {revising ? <LoaderCircle className="hunting-spin" size={16} /> : <Sparkles size={16} />}
              {revising ? "Preparing factual revision" : "Edit CV with J.A.R.V.I.S."}
            </button>
          </HoloPanel>

          {warnings.length ? (
            <div className="hunting-warning-list">
              <div><AlertTriangle size={16} /> Facts needed</div>
              {warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          ) : null}

          <HoloPanel title="Private profile controls">
            <div className="hunting-control-list">
              <button onClick={download} disabled={!content.trim()}>
                <Download size={16} /><span><b>Download Markdown</b><small>Export the current draft</small></span>
              </button>
              <button onClick={() => void downloadPdf()} disabled={content.trim().length < 40 || downloadingPdf}>
                {downloadingPdf ? <LoaderCircle className="hunting-spin" size={16} /> : <FileText size={16} />}
                <span><b>Download PDF</b><small>{sourcePdfToken || (savedCv?.hasOriginalPdf && !dirty) ? "Export with preserved styling" : "Export from the locked template"}</small></span>
              </button>
              <button onClick={proposeMemory} disabled={!savedCv || dirty || proposing}>
                {proposing ? <LoaderCircle className="hunting-spin" size={16} /> : <LockKeyhole size={16} />}
                <span><b>Stage memory facts</b><small>Creates an approval request only</small></span>
              </button>
            </div>
          </HoloPanel>
        </div>
      </div>

      {takeover ? (
        <Suspense fallback={null}>
          <BrowserTakeover
            targetId={takeover.targetId}
            url={takeover.url}
            onClose={() => setTakeover(null)}
            onResume={
              takeover.jobId
                ? () => {
                    const job = jobs.find((entry) => entry.id === takeover.jobId);
                    if (job) void runApplication(job, true);
                  }
                : undefined
            }
          />
        </Suspense>
      ) : null}
    </section>
  );
}

function WorkflowStep({ number, title, detail, active = false }: { number: string; title: string; detail: string; active?: boolean }) {
  return (
    <div className={active ? "hunting-step hunting-step--active" : "hunting-step"}>
      <span>{number}</span>
      <div><strong>{title}</strong><small>{detail}</small></div>
    </div>
  );
}

function ApplicationCheckpoint({
  application,
  busy,
  onResume,
  onSubmitted,
  onSubmitWithJarvis,
  onTakeover,
}: {
  application: HuntingApplication;
  busy: boolean;
  onResume: (guidance?: string, attachmentIds?: string[]) => Promise<boolean>;
  onSubmitted: (manualRecoveryConfirmed?: boolean) => void;
  onSubmitWithJarvis: () => void;
  onTakeover: () => void;
}) {
  const [attempts, setAttempts] = useState<HuntingApplicationAttempt[] | null>(null);
  const [letter, setLetter] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [guidanceAttachments, setGuidanceAttachments] = useState<StoredAttachment[]>([]);
  const [uploadingGuidance, setUploadingGuidance] = useState(false);
  const [guidanceFileError, setGuidanceFileError] = useState<string | null>(null);
  const guidanceFileInput = useRef<HTMLInputElement>(null);
  const [sendingGuidance, setSendingGuidance] = useState(false);
  const userCancelled = application.reasonCode === "user_cancelled";
  const needsAction =
    !userCancelled && (application.status === "needs_human_action" || application.status === "failed");

  async function addGuidanceFiles(files: FileList | File[] | null) {
    if (!files?.length || uploadingGuidance) return;
    setUploadingGuidance(true);
    setGuidanceFileError(null);
    try {
      const response = await api.uploadAttachments(Array.from(files));
      setGuidanceAttachments((current) => [...current, ...response.attachments].slice(0, 5));
    } catch (error) {
      setGuidanceFileError(errorMessage(error));
    } finally {
      setUploadingGuidance(false);
      if (guidanceFileInput.current) guidanceFileInput.current.value = "";
    }
  }
  const submissionRejected = application.reasonCode?.startsWith("submission_") === true;
  const { isDragging, dropProps, pasteProps } = useAttachmentDrop({
    onFiles: addGuidanceFiles,
    disabled: !needsAction || busy || uploadingGuidance,
  });
  return (
    <section className={`hunting-application hunting-application--${application.status}`}>
      <div className="hunting-application__heading">
        <span><ShieldCheck size={13} /> Application checkpoint</span>
        <b>{applicationStatusLabel(application)}</b>
      </div>
      <p>{application.summary}</p>
      {application.tailoredCvName ? (
        <small><FileText size={12} /> {application.tailoredCvName}</small>
      ) : null}
      <div className={`hunting-application__upload hunting-application__upload--${application.uploadOutcome}`}>
        <Paperclip size={12} />
        <span>{uploadOutcomeLabel(application)}</span>
      </div>
      {application.manualAction ? (
        <div className="hunting-application__manual">
          <AlertTriangle size={14} />
          <span>{application.manualAction}</span>
        </div>
      ) : null}
      {needsAction && application.manualActionKind === "legal_acceptance" ? (
        // Typing the same permission into the box every time is the friction this removes: one
        // click grants it for this site and the run continues from where it stopped.
        <button
          type="button"
          className="hunting-application__consent"
          disabled={busy || sendingGuidance}
          onClick={() => {
            setSendingGuidance(true);
            void onResume(CONSENT_GRANT_PHRASE).finally(() => setSendingGuidance(false));
          }}
        >
          <ShieldCheck size={12} />
          Accept on my behalf and remember it for this site
        </button>
      ) : null}
      {needsAction && !submissionRejected ? (
        <form
          {...dropProps}
          {...pasteProps}
          className={`hunting-application__guidance${isDragging ? " attachment-dropzone" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            const message = guidance.trim() || (guidanceAttachments.length ? "Use the attached files as guidance for this application." : "");
            if (!message || busy || sendingGuidance || uploadingGuidance) return;
            setSendingGuidance(true);
            void onResume(message, guidanceAttachments.map(({ id }) => id))
              .then((accepted) => {
                if (accepted) {
                  setGuidance("");
                  setGuidanceAttachments([]);
                }
              })
              .finally(() => setSendingGuidance(false));
          }}
        >
          <label htmlFor={`application-guidance-${application.jobId}`}>Tell J.A.R.V.I.S. what to do</label>
          <textarea
            id={`application-guidance-${application.jobId}`}
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Example: Re-open the dropdown, choose the matching option, then verify the selected value before continuing."
            disabled={busy || sendingGuidance}
          />
          {guidanceAttachments.length ? (
            <div className="hunting-application__guidance-files">
              {guidanceAttachments.map((attachment) => (
                <span key={attachment.id}><Paperclip size={11} />{attachment.fileName}<button type="button" aria-label={`Remove ${attachment.fileName}`} onClick={() => setGuidanceAttachments((current) => current.filter(({ id }) => id !== attachment.id))}><X size={11} /></button></span>
              ))}
            </div>
          ) : null}
          {guidanceFileError ? <small className="hunting-application__guidance-error">{guidanceFileError}</small> : null}
          <div>
            <small>
              Do not enter passwords, one-time codes, or recovery codes. A reusable lesson is saved only if the live form verifies the retry worked.
            </small>
            <input ref={guidanceFileInput} className="sr-only" type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={(event) => void addGuidanceFiles(event.target.files)} />
            <button type="button" className="hunting-application__attach" disabled={busy || sendingGuidance || uploadingGuidance} onClick={() => guidanceFileInput.current?.click()} title="Attach files" aria-label="Attach files">
              {uploadingGuidance ? <LoaderCircle className="hunting-spin" size={12} /> : <Paperclip size={12} />}
            </button>
            <button type="submit" disabled={(!guidance.trim() && !guidanceAttachments.length) || busy || sendingGuidance || uploadingGuidance}>
              {sendingGuidance ? <LoaderCircle className="hunting-spin" size={12} /> : <Send size={12} />}
              {sendingGuidance ? "Sending" : "Send & resume"}
            </button>
          </div>
        </form>
      ) : null}
      {hasUsage(application.usage) ? (
        <div className="hunting-application__usage">
          <Coins size={12} />
          <span>{describeApplicationUsage(application.usage)}</span>
        </div>
      ) : null}
      {application.coverLetter?.name ? (
        <div className="hunting-application__letter">
          <PencilLine size={12} />
          <span>
            Cover letter written for this role{application.coverLetter.words ? ` · ${application.coverLetter.words} words` : ""}
          </span>
          <button
            onClick={() => {
              if (letter) {
                setLetter(null);
                return;
              }
              void api
                .huntingCoverLetter(application.jobId)
                // `letter` is the sendable text; the file also holds which-application metadata.
                .then((response) => setLetter(response.coverLetter.letter))
                .catch(() => setLetter("The saved cover letter could not be read."));
            }}
          >
            {letter ? "Hide" : "Read it"}
          </button>
        </div>
      ) : null}
      {letter ? <pre className="hunting-application__letter-body">{letter}</pre> : null}
      {application.filledFields.length ? (
        <ul className="hunting-application__filled">
          {application.filledFields.map((field) => (
            <li key={field.field}>
              {field.field}
              {field.selectedOption ? <em> = {field.selectedOption}</em> : null}
              <small>from {field.source}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {application.unresolvedFields.length ? (
        <ul className="hunting-application__unresolved">
          {application.unresolvedFields.map((field) => (
            <li key={field.field}>{field.field}: {field.reason}</li>
          ))}
        </ul>
      ) : null}
      {application.skippedFields.length ? (
        <details className="hunting-application__skipped">
          <summary>{application.skippedFields.length} optional field(s) left blank</summary>
          <ul>
            {application.skippedFields.map((field) => (
              <li key={field.field}>{field.field}: {field.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {attempts ? (
        <ol className="hunting-application__attempts">
          {attempts.map((attempt) => (
            <li key={attempt.id}>
              <b>{attempt.phase}</b> · {attempt.outcome}
              {attempt.reasonCode ? ` (${attempt.reasonCode})` : ""} · {formatTimestamp(attempt.createdAt)}
              {attempt.detail ? <small>{attempt.detail}</small> : null}
            </li>
          ))}
          {attempts.length ? null : <li>No attempts recorded yet.</li>}
        </ol>
      ) : null}
      <div className="hunting-application__footer">
        <span>{application.filledFields.length} verified fields filled</span>
        <div>
          <button
            onClick={() => {
              if (attempts) {
                setAttempts(null);
                return;
              }
              void api
                .huntingApplicationAttempts(application.jobId)
                .then((response) => setAttempts(response.attempts))
                .catch(() => setAttempts([]));
            }}
          >
            <History size={12} /> {attempts ? "Hide audit" : "Audit trail"}
          </button>
          {application.currentUrl ? (
            <a href={application.currentUrl} target="_blank" rel="noreferrer">
              {submissionRejected ? "Open in my normal browser" : "Open current page"} <ArrowUpRight size={12} />
            </a>
          ) : null}
          {/* A CAPTCHA or sign-in lives in the headless container browser, so the mirror is
              the only place it can be answered; Screens shows desktops, not that browser. */}
          {needsAction && !submissionRejected ? (
            <button className="hunting-application__takeover" onClick={onTakeover}>
              <MonitorSmartphone size={12} /> {browserActionLabel(application.manualActionKind)}
            </button>
          ) : null}
          {needsAction && !submissionRejected ? (
            <button onClick={() => void onResume()} disabled={busy}><RefreshCw className={busy ? "hunting-spin" : undefined} size={12} /> Resume</button>
          ) : null}
          {needsAction && submissionRejected ? (
            <button
              className="hunting-application__submitted"
              onClick={() => {
                if (window.confirm("Confirm that the separate normal-browser attempt shows the application was accepted?")) onSubmitted(true);
              }}
              disabled={busy}
            >
              <Check size={12} /> Confirm manual submission
            </button>
          ) : null}
          {application.status === "ready_for_review" ? (
            <button
              className="hunting-application__submitted"
              onClick={() => {
                if (
                  window.confirm(
                    "Submit this application now? J.A.R.V.I.S. will click the employer's Submit button once, then verify the response. It will not retry if the employer rejects it.",
                  )
                ) onSubmitWithJarvis();
              }}
              disabled={busy}
            >
              <Check size={12} /> Submit with J.A.R.V.I.S.
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function applicationStatusLabel(application: HuntingApplication) {
  if (application.reasonCode === "user_cancelled") return "Cancelled";
  const status = application.status;
  if (status === "queued") return "Queued";
  if (status === "preparing_cv") return "Tailoring CV";
  if (status === "opening_form") return "Opening form";
  if (status === "uploading_cv") return "Attaching CV";
  if (status === "filling_verified_fields") return "Filling verified fields";
  if (status === "needs_human_action") return "Needs you";
  if (status === "ready_for_review") return "Ready for final review";
  if (status === "submitted") return "Submitted";
  return "Stopped";
}

/** The upload line is the checkpoint's honesty: it never claims more than was verified. */
function uploadOutcomeLabel(application: HuntingApplication) {
  if (
    application.uploadOutcome === "uploaded" &&
    application.uploadEvidence?.method === "site-review-controls"
  ) {
    return "Resume attached and verified on the site's final review page";
  }
  const filename =
    (application.uploadEvidence?.filename as string | undefined) ?? application.tailoredCvName ?? "the CV";
  switch (application.uploadOutcome) {
    case "uploaded":
      return `${filename} attached and verified on the page${
        application.uploadVerifiedAt ? ` at ${formatTimestamp(application.uploadVerifiedAt)}` : ""
      }`;
    case "not_required":
      return "This form asks for no CV";
    case "pending":
      return "CV not attached yet";
    case "artifact_unavailable":
      return "The browser host could not read the prepared CV";
    case "input_not_found":
      return "No reachable CV upload control on the form";
    case "tool_unavailable":
      return "The OpenClaw browser did not answer the upload call";
    case "verification_failed":
      return "Upload could not be verified on the page";
    default:
      return "The form rejected the upload";
  }
}

/** Older checkpoints predate metering and carry an empty object. */
function hasUsage(usage: HuntingApplication["usage"]): usage is HuntingApplicationUsage {
  return "tokens" in usage;
}

/**
 * Cost is always shown; the plan percentage only for oauth, where a subscription quota is the
 * real cost. On an api key the dollars are the charge, so a percentage would be meaningless.
 */
function describeApplicationUsage(usage: HuntingApplicationUsage) {
  const tokens = `${formatTokens(usage.tokens.total)} tokens`;
  const money =
    usage.cost.basis === "api_list_price_equivalent"
      ? `~$${usage.cost.amount.toFixed(4)} at API list price (plan already paid)`
      : `~$${usage.cost.amount.toFixed(4)} charged`;
  const window = usage.quota?.windows?.[0];
  if (!window) return `${tokens} · ${money}`;
  const movement =
    window.deltaPoints === null
      ? ""
      : window.deltaPoints > 0
        ? ` · plan +${window.deltaPoints} pt`
        : " · plan under 1 pt";
  const reset = window.resetAt ? `, resets ${formatTimestamp(new Date(window.resetAt).toISOString())}` : "";
  return `${tokens} · ${money}${movement} (${window.label} window at ${window.usedPercentAfter}%${reset})`;
}

function formatTokens(total: number) {
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

function isChallengeReason(reason: string | null) {
  return Boolean(reason && /captcha|challenge|anti-?bot|blocked|verify|unusual traffic|sorry/i.test(reason));
}

function browserActionLabel(kind: HuntingApplication["manualActionKind"]) {
  if (kind === "captcha") return "Solve the CAPTCHA myself";
  if (kind === "sign_in") return "Sign in myself";
  if (kind === "verification") return "Complete verification myself";
  return "Take over browser";
}

function freshnessLabel(freshness: HuntingJob["freshness"]) {
  if (freshness === "new") return "New";
  if (freshness === "current") return "Still current";
  if (freshness === "stale") return "Stale";
  return "Historical";
}

function freshnessDetail(job: HuntingJob) {
  if (job.freshness === "new") return "First seen in the latest hunt";
  if (job.freshness === "current") return `Re-observed ${job.lastSeenAt ? formatTimestamp(job.lastSeenAt) : "recently"}`;
  if (job.freshness === "stale") return "Not revalidated recently, or the posting date is older than 14 days";
  return "Not seen in the latest hunt";
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read the selected CV"));
    reader.onload = () => resolve(String(reader.result ?? "").split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatPostingDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function commaList(value: string) {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}
