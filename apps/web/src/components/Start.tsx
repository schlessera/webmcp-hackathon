import { useEffect, useRef, useState } from "react";
import {
  createRoom,
  fetchAreas,
  previewPlan,
  type AreaSummary,
  type CreatedRoom,
  type ParsedNeed,
  type PlanClarification,
  type StepClassSummary,
} from "../api.ts";
import { COPY, asOf } from "../ui/copy.ts";
import { Wordmark } from "./Wordmark.tsx";

/**
 * The only screen before a room: pick an area, say who is coming, open it.
 *
 * Every number on an area card was measured from that area's OpenStreetMap
 * extract by the snapshot builder (docs/DATA-QUALITY.md) and arrives from
 * the server — nothing here is typed into the component. Counts are
 * absolute, never percentages (CLAUDE.md §10); the meter is a drawing of the
 * same two numbers, with the unknown share hollow (§4).
 *
 * Nothing here names a domain: the area label is server data, the places are
 * "places", the facts are "facts".
 */

interface Props {
  onOpen(inviteSecret: string): void;
  /** Present when the picker was reached from the landing page. */
  onBack?(): void;
}

function inviteUrl(inviteSecret: string): string {
  return `${window.location.origin}/#invite=${inviteSecret}`;
}

const DEFAULT_CLASS: StepClassSummary = {
  key: "food",
  label: "somewhere to eat",
  count: 0,
};

interface DraftPlan {
  goal: string;
  title: string;
  classes: StepClassSummary[];
  placeClass: string;
  needs: ParsedNeed[];
  clarify: PlanClarification | null;
  offline: boolean;
}

function areaClasses(area: AreaSummary | undefined): StepClassSummary[] {
  return area?.classes?.length ? area.classes : [DEFAULT_CLASS];
}

function mergeNeeds(before: ParsedNeed[], after: ParsedNeed[]): ParsedNeed[] {
  const seen = new Set(before.map((need) => JSON.stringify([need.payload, need.label])));
  return [
    ...before,
    ...after.filter((need) => {
      const key = JSON.stringify([need.payload, need.label]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

function ClassSelector({
  classes,
  value,
  onChange,
}: {
  classes: StepClassSummary[];
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="start-class-field">
      <span>{COPY.startClassLabel}</span>
      <select value={value} data-testid="start-class" onChange={(event) => onChange(event.target.value)}>
        {classes.map((item) => (
          <option value={item.key} key={item.key}>
            {item.label}{item.count > 0 ? ` · ${item.count} places` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function AreaCard({
  area,
  checked,
  onPick,
}: {
  area: AreaSummary;
  checked: boolean;
  onPick(): void;
}) {
  const c = area.coverage;
  const pool = c?.pool;
  const known = pool?.decisive ?? 0;
  const slots = pool?.slots ?? 0;
  const hours = pool?.tagCounts.opening_hours ?? 0;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="area-card card"
      data-checked={checked || undefined}
      data-testid={`area-${area.id}`}
      disabled={!area.available}
      onClick={onPick}
    >
      <span className="area-name">{area.label}</span>
      {c ? (
        <>
          <span className="area-line">
            {c.focus.venues} places within {c.focus.venues && area.radii.wide / 1000} km ·{" "}
            {c.city.venues.toLocaleString()} across {area.city}
          </span>
          <span className="area-line">A room starts with the {pool!.venues} nearest.</span>
          <span className="area-meter" aria-hidden="true">
            <span
              className="area-meter-known"
              style={{ width: `${slots ? (known / slots) * 100 : 0}%` }}
            />
          </span>
          <span className="area-line area-facts">
            <span className="mark" aria-hidden="true" /> {known} of {slots} facts on record
            <span className="mark" data-mark="unknown" aria-hidden="true" /> {slots - known} unknown
          </span>
          <span className="area-line">
            {hours} of {pool!.venues} list opening hours
          </span>
          <span className="area-asof">
            {area.source}, as of {asOf(area.dataAsOf)}
          </span>
        </>
      ) : (
        <span className="area-line">
          {area.available
            ? `${area.source}, as of ${asOf(area.dataAsOf)}. Coverage not measured.`
            : "No place data here yet."}
        </span>
      )}
    </button>
  );
}

export function Start({ onOpen, onBack }: Props) {
  const [areas, setAreas] = useState<AreaSummary[] | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [you, setYou] = useState("Alex");
  const [others, setOthers] = useState(["Sarah", "Joe"]);
  const [goal, setGoal] = useState("");
  const [placeClass, setPlaceClass] = useState(DEFAULT_CLASS.key);
  const [plan, setPlan] = useState<DraftPlan | null>(null);
  const [clarifyText, setClarifyText] = useState("");
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<CreatedRoom | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAreas()
      .then((list) => {
        if (cancelled) return;
        setAreas(list);
        const first = list.find((a) => a.available);
        setAreaId(first?.id ?? null);
        setPlaceClass(areaClasses(first)[0]!.key);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the areas. Reload to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedArea = areas?.find((area) => area.id === areaId);
  const availableClasses = plan?.classes ?? areaClasses(selectedArea);

  // A preview can take a while; editing the goal or switching the area while
  // it is in flight supersedes it, and its answer must not come back as the plan.
  const previewSeq = useRef(0);

  const selectArea = (area: AreaSummary) => {
    previewSeq.current += 1;
    setBusy(null);
    setAreaId(area.id);
    setPlaceClass(areaClasses(area)[0]!.key);
    setPlan(null);
    setClarifyText("");
  };

  const readPlan = async (words: string, retained: ParsedNeed[] = []) => {
    if (!areaId) return;
    const seq = ++previewSeq.current;
    setBusy("preview");
    setError(null);
    const preview = await previewPlan({ areaId, goal: words });
    if (seq !== previewSeq.current) return;
    const fallbackClasses = areaClasses(selectedArea);
    if (!preview || preview.steps.length === 0) {
      const selected = fallbackClasses.find((item) => item.key === placeClass) ?? fallbackClasses[0]!;
      setPlan({
        goal: goal.trim(),
        title: selected.label,
        classes: fallbackClasses,
        placeClass: selected.key,
        needs: retained,
        clarify: null,
        offline: true,
      });
      setBusy(null);
      return;
    }
    const step = preview.steps[0]!;
    const classes = preview.classes.length ? preview.classes : fallbackClasses;
    const previewClass = classes.some((item) => item.key === step.placeClass.key)
      ? step.placeClass.key
      : classes[0]!.key;
    setPlaceClass(previewClass);
    setPlan({
      goal: goal.trim(),
      title: step.title,
      classes,
      placeClass: previewClass,
      needs: mergeNeeds(retained, step.needs),
      clarify: preview.clarify,
      offline: preview.offline,
    });
    setBusy(null);
  };

  const open = async () => {
    if (!areaId) return;
    const trimmedGoal = goal.trim();
    if (trimmedGoal && !plan) {
      await readPlan(trimmedGoal);
      return;
    }
    setBusy("create");
    setError(null);
    const chosenClass = plan?.placeClass ?? placeClass;
    const keptNeeds = plan?.needs ?? [];
    const result = await createRoom({
      areaId,
      organizerName: you,
      memberNames: others.map((n) => n.trim()).filter(Boolean),
      ...(trimmedGoal ? { goal: trimmedGoal } : {}),
      step: {
        placeClass: chosenClass,
        ...(keptNeeds.length ? { needs: keptNeeds } : {}),
      },
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRoom(result.room);
  };

  const chooseClarification = (choice: PlanClarification["choices"][number]) => {
    setPlan((current) =>
      current
        ? { ...current, needs: mergeNeeds(current.needs, choice.needs), clarify: null }
        : current,
    );
    setClarifyText("");
  };

  const submitClarification = async () => {
    const answer = clarifyText.trim();
    if (!answer || !plan || busy) return;
    const retained = plan.needs;
    setClarifyText("");
    await readPlan(`${plan.goal} ${answer}`.slice(0, 300), retained);
  };

  const copy = async (secret: string, id: string) => {
    try {
      await navigator.clipboard.writeText(inviteUrl(secret));
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      setCopied(null);
    }
  };

  if (room) {
    const organizer = room.invites.find((i) => i.role === "organizer")!;
    const roomGoal = room.goal || goal.trim() || `Somewhere in ${selectedArea?.label ?? "the area"}`;
    return (
      <div className="start" data-testid="start-links">
        <Wordmark />
        <h1 className="start-title">Your room is open</h1>
        <p className="invite-goal" data-testid="invite-goal">{roomGoal}</p>
        <p className="start-lede">
          Each link is one person's way in. Send the others theirs; keep yours.
        </p>
        <ul className="invite-list">
          {room.invites.map((i) => (
            <li key={i.participantId} className="invite-row card">
              <span className="invite-name">
                {i.displayName}
                {i.role === "organizer" && <span className="invite-role"> · you</span>}
              </span>
              <button
                type="button"
                className="invite-copy"
                onClick={() => void copy(i.inviteSecret, i.participantId)}
                data-testid={`copy-${i.participantId}`}
              >
                {copied === i.participantId ? "Copied" : "Copy link"}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="start-button"
          data-testid="enter-room"
          onClick={() => onOpen(organizer.inviteSecret)}
        >
          Open the room as {organizer.displayName}
        </button>
      </div>
    );
  }

  return (
    <div className="start" data-testid="start">
      <div className="start-top">
        <span className="start-brand">
          <Wordmark />
        </span>
        {onBack && (
          <button type="button" className="btn start-back" data-testid="start-back" onClick={onBack}>
            Back
          </button>
        )}
      </div>
      <h1 className="start-title">Open a room</h1>
      <p className="start-lede">{COPY.startLede}</p>

      <label className="start-goal">
        <span>{COPY.startGoalLabel}</span>
        <input
          value={goal}
          maxLength={300}
          placeholder={COPY.startGoalPlaceholder}
          data-testid="start-goal"
          onChange={(event) => {
            previewSeq.current += 1;
            setBusy(null);
            setGoal(event.target.value);
            setPlan(null);
            setClarifyText("");
          }}
        />
        <small>{COPY.startGoalOptional}</small>
      </label>

      {error && (
        <p role="alert" className="start-error">
          {error}
        </p>
      )}

      <div className="area-list" role="radiogroup" aria-label="Area">
        {areas === null && !error && <span className="start-quiet">Loading the areas…</span>}
        {areas?.map((a) => (
          <AreaCard key={a.id} area={a} checked={areaId === a.id} onPick={() => selectArea(a)} />
        ))}
      </div>
      <p className="start-note">{COPY.startUnknown}</p>

      {!plan && (
        <ClassSelector classes={availableClasses} value={placeClass} onChange={setPlaceClass} />
      )}

      {plan && (
        <section className="plan-card card" data-testid="plan-preview">
          <div className="card-kicker">{COPY.startPlanKicker}</div>
          <div className="plan-heading">{plan.title}</div>
          <ClassSelector
            classes={availableClasses}
            value={plan.placeClass}
            onChange={(next) => {
              setPlaceClass(next);
              setPlan((current) => (current ? { ...current, placeClass: next } : current));
            }}
          />
          {plan.offline && <p className="plan-offline">{COPY.startPlanOffline}</p>}
          {plan.needs.length > 0 && (
            <div className="plan-needs" aria-label={COPY.startPlanNeeds}>
              {plan.needs.map((need, index) => (
                <div
                  className="plan-need"
                  data-pending="true"
                  data-testid="plan-need"
                  key={`${need.label}-${index}`}
                >
                  <span className="mark" data-mark="silent" aria-hidden="true" />
                  <span className="plan-need-label">
                    {need.label}
                    {need.assumed && <small> · {need.assumed}</small>}
                  </span>
                  <button
                    type="button"
                    className="btn-text plan-drop"
                    data-testid={`drop-plan-need-${index}`}
                    onClick={() =>
                      setPlan((current) =>
                        current
                          ? { ...current, needs: current.needs.filter((_, itemIndex) => itemIndex !== index) }
                          : current,
                      )
                    }
                  >
                    {COPY.startDropNeed}
                  </button>
                </div>
              ))}
            </div>
          )}
          {plan.clarify && (
            <div className="plan-clarify card" data-tone="dashed" data-testid="plan-clarify">
              <div className="card-body">{plan.clarify.question}</div>
              <div className="reply-choices" role="group" aria-label={plan.clarify.question}>
                {plan.clarify.choices.map((choice) => (
                  <button
                    type="button"
                    className="pill"
                    key={choice.id}
                    onClick={() => chooseClarification(choice)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
              {plan.clarify.allowFreeText && (
                <label className="plan-clarify-free">
                  <span>{COPY.startClarifyFree}</span>
                  <span className="plan-clarify-input">
                    <input
                      value={clarifyText}
                      maxLength={300}
                      data-testid="plan-clarify-text"
                      onChange={(event) => setClarifyText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submitClarification();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={!clarifyText.trim() || busy !== null}
                      onClick={() => void submitClarification()}
                    >
                      {COPY.startClarifyUse}
                    </button>
                  </span>
                </label>
              )}
            </div>
          )}
        </section>
      )}

      <div className="start-names">
        <label className="start-field">
          <span>You</span>
          <input value={you} maxLength={40} onChange={(e) => setYou(e.target.value)} data-testid="name-you" />
        </label>
        {others.map((name, i) => (
          <label className="start-field" key={i}>
            <span>{i === 0 ? "Who else" : ""}</span>
            <input
              value={name}
              maxLength={40}
              onChange={(e) =>
                setOthers((prev) => prev.map((n, j) => (j === i ? e.target.value : n)))
              }
              data-testid={`name-other-${i}`}
            />
          </label>
        ))}
        {others.length < 5 && (
          <button
            type="button"
            className="start-add"
            onClick={() => setOthers((prev) => [...prev, ""])}
          >
            One more
          </button>
        )}
      </div>

      <button
        type="button"
        className="start-button"
        disabled={busy !== null || !areaId || you.trim().length === 0}
        onClick={() => void open()}
        data-testid="open-room"
        aria-busy={busy !== null || undefined}
      >
        {busy && <i className="busy-ring row-busy" aria-hidden="true" />}
        {busy === "preview"
          ? COPY.startReadingPlan
          : busy === "create"
            ? COPY.startOpeningRoom
            : goal.trim() && !plan
              ? COPY.startReviewPlan
              : "Open the room"}
      </button>
    </div>
  );
}
