// Configure a standing extraction task: who runs it, which sites, which travel
// dates, how long a stay, and on which weekdays.
//
// Validation lives on the server (extraction-tasks.js) so a task created by any
// caller is checked the same way; this form's job is to make the shape obvious
// and to surface the server's complaint verbatim rather than guessing at it.
import { useMemo, useState } from "react";
import { CalendarClock, ChevronDown, Plus } from "lucide-react";
import type { AgentRoomAgent } from "./AgentRoom";
import type { ExtractionTaskInput, Weekday } from "../lib/api";

const WEEKDAY_OPTIONS: { key: Weekday; label: string }[] = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

// Only sites with a proven extraction protocol can be selected. The rest are
// listed so the roadmap is visible, but the server rejects them too.
const PRIMARY_SITES = ["ProviderA", "ProviderD", "ProviderC", "ProviderB"];
const SOON_SITES = ["Holiday Hypermarket", "Multiple competitor comparison"];
const NO_COMPARISON = "";

export function weekdaySummary(weekdays: Weekday[], emptyText = "no days chosen"): string {
  if (weekdays.length === 0) return emptyText;
  if (weekdays.length === 7) return "every day";
  return WEEKDAY_OPTIONS.filter((day) => weekdays.includes(day.key))
    .map((day) => day.label.slice(0, 3))
    .join(", ");
}

/**
 * Used twice with different meanings — which departure dates to search, and
 * which days the job runs — so the two stay visually identical but separate.
 */
function WeekdayPicker({
  selected,
  onToggle,
  open,
  onOpenChange,
  label,
  emptyText,
}: {
  selected: Weekday[];
  onToggle: (day: Weekday) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  emptyText: string;
}) {
  return (
    <div className="relative">
      <button
        onClick={() => onOpenChange(!open)}
        className={`${inputClass} flex items-center justify-between text-left`}
        aria-expanded={open}
        aria-label={label}
      >
        <span className={selected.length === 0 ? "text-gray-500" : undefined}>
          {weekdaySummary(selected, emptyText)}
        </span>
        <ChevronDown size={12} className="text-gray-500" />
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-full rounded border border-hudborder bg-surface-1 p-1 shadow-glow-sm">
          {WEEKDAY_OPTIONS.map((day) => (
            <label
              key={day.key}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono text-[0.65rem] text-gray-300 hover:bg-surface-3"
            >
              <input
                type="checkbox"
                checked={selected.includes(day.key)}
                onChange={() => onToggle(day.key)}
                className="accent-accent"
              />
              {day.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function fieldLabel(text: string) {
  return <div className="hud-label mb-1 text-[0.55rem]">{text}</div>;
}

const inputClass =
  "w-full rounded border border-hudborder bg-surface-1 px-2 py-1 font-mono text-xs text-gray-200 outline-none focus:border-accent/60";

export default function ExtractionTaskForm({
  agents,
  busy,
  onCreate,
}: {
  agents: AgentRoomAgent[];
  busy: boolean;
  onCreate: (input: ExtractionTaskInput) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [destination, setDestination] = useState("Antalya");
  const [primarySite, setPrimarySite] = useState(PRIMARY_SITES[0]);
  const [comparisonSite, setComparisonSite] = useState(NO_COMPARISON);
  const [travelStart, setTravelStart] = useState("");
  const [travelEnd, setTravelEnd] = useState("");
  const [nights, setNights] = useState("7");
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [departureDays, setDepartureDays] = useState<Weekday[]>([]);
  const [departureDaysOpen, setDepartureDaysOpen] = useState(false);
  const [scheduleStart, setScheduleStart] = useState("");
  const [scheduleEnd, setScheduleEnd] = useState("");
  const [daysOpen, setDaysOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentOptions = useMemo(
    () => agents.map((agent) => ({ id: agent.id, label: agent.identity?.name?.trim() || agent.name || agent.id })),
    [agents],
  );
  const effectiveAgentId = agentId || agentOptions[0]?.id || "";

  const toggleDay = (setter: typeof setWeekdays, day: Weekday) =>
    setter((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));

  const submit = async () => {
    setError(null);
    try {
      await onCreate({
        agentId: effectiveAgentId,
        destination,
        // The second dropdown is the comparison; empty means a single site.
        sites: comparisonSite === NO_COMPARISON ? [primarySite] : [primarySite, comparisonSite],
        travelStart,
        travelEnd,
        departureDays,
        nights,
        weekdays,
        scheduleStart,
        scheduleEnd,
      });
      setOpen(false);
      setWeekdays([]);
      setDepartureDays([]);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-hudborder px-3 py-2 font-mono text-[0.65rem] text-gray-400 transition-colors hover:border-accent/50 hover:text-accent-hover"
      >
        <Plus size={13} /> New extraction task
      </button>
    );
  }

  return (
    <div className="mb-3 space-y-2.5 rounded-lg border border-accent/30 bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <CalendarClock size={13} className="text-accent" />
        <span className="hud-label text-[0.6rem]">New extraction task</span>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto font-mono text-[0.6rem] text-gray-500 hover:text-gray-300"
        >
          cancel
        </button>
      </div>

      <div>
        {fieldLabel("Agent")}
        <select
          value={effectiveAgentId}
          onChange={(event) => setAgentId(event.target.value)}
          className={inputClass}
          aria-label="Agent responsible for this extraction"
        >
          {agentOptions.length === 0 && <option value="">No agents available</option>}
          {agentOptions.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        {fieldLabel("Destination")}
        <input
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          placeholder="Antalya"
          className={inputClass}
          aria-label="Destination"
        />
      </div>

      <div>
        {fieldLabel("Websites")}
        <div className="flex items-center gap-1.5">
          <select
            value={primarySite}
            onChange={(event) => setPrimarySite(event.target.value)}
            className={inputClass}
            aria-label="Primary website"
          >
            {PRIMARY_SITES.map((site) => (
              <option key={site} value={site}>
                {site}
              </option>
            ))}
          </select>
          <span className="shrink-0 font-mono text-[0.6rem] text-gray-500">vs</span>
          <select
            value={comparisonSite}
            onChange={(event) => setComparisonSite(event.target.value)}
            className={inputClass}
            aria-label="Comparison website"
          >
            <option value={NO_COMPARISON}>— none —</option>
            {PRIMARY_SITES.filter((site) => site !== primarySite).map((site) => (
              <option key={site} value={site}>
                {site}
              </option>
            ))}
            {SOON_SITES.map((site) => (
              <option key={site} value={site} disabled>
                {site} — available soon
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          {fieldLabel("Travel from")}
          <input
            type="date"
            value={travelStart}
            onChange={(event) => setTravelStart(event.target.value)}
            className={inputClass}
            aria-label="Travel date range start"
          />
        </div>
        <div>
          {fieldLabel("Travel until")}
          <input
            type="date"
            value={travelEnd}
            onChange={(event) => setTravelEnd(event.target.value)}
            className={inputClass}
            aria-label="Travel date range end"
          />
        </div>
      </div>

      <div>
        {fieldLabel("Nights")}
        <input
          value={nights}
          onChange={(event) => setNights(event.target.value)}
          placeholder="7, or a range like 7-10"
          className={inputClass}
          aria-label="Nights"
        />
      </div>

      <div>
        {fieldLabel("Departure days")}
        <WeekdayPicker
          selected={departureDays}
          onToggle={(day) => toggleDay(setDepartureDays, day)}
          open={departureDaysOpen}
          onOpenChange={setDepartureDaysOpen}
          label="Departure weekdays to search"
          emptyText="every day in the range"
        />
        <p className="mt-1 font-mono text-[0.55rem] text-gray-600">
          Which departure dates to price up. Leave empty for every day.
        </p>
      </div>

      <div>
        {fieldLabel("Run on")}
        <WeekdayPicker
          selected={weekdays}
          onToggle={(day) => toggleDay(setWeekdays, day)}
          open={daysOpen}
          onOpenChange={setDaysOpen}
          label="Days of the week to run on"
          emptyText="no days chosen"
        />
        <p className="mt-1 font-mono text-[0.55rem] text-gray-600">
          When the extraction itself runs — not which dates it searches.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          {fieldLabel("Schedule from")}
          <input
            type="date"
            value={scheduleStart}
            onChange={(event) => setScheduleStart(event.target.value)}
            className={inputClass}
            aria-label="Schedule period start"
          />
        </div>
        <div>
          {fieldLabel("Schedule until")}
          <input
            type="date"
            value={scheduleEnd}
            onChange={(event) => setScheduleEnd(event.target.value)}
            className={inputClass}
            aria-label="Schedule period end"
          />
        </div>
      </div>

      {error && <p className="font-mono text-[0.6rem] text-red-300">{error}</p>}

      <button
        onClick={submit}
        disabled={busy}
        className="w-full rounded border border-accent/50 bg-accent/10 px-3 py-1.5 font-mono text-[0.65rem] text-accent-hover hover:bg-accent/20 disabled:opacity-40"
      >
        {busy ? "Creating…" : "Create task"}
      </button>
    </div>
  );
}
