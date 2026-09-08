import { useEffect, useRef, useState } from "react";
import {
  createRoom,
  fetchAreas,
  previewPlan,
  type AreaSummary,
  type CreatedRoom,
  type ParsedNeed,
  type PlanClarification,
  type PlanStepView,
  type StepClassSummary,
} from "../api.ts";
import { COPY } from "../ui/copy.ts";
import { Wordmark } from "./Wordmark.tsx";
import { RegionDialog } from "./RegionDialog.tsx";

/**
 * Opening a room, in the order a product would ask.
 *
 * Who you are and what you are trying to do, then what that turns out to
 * take, then — only because this is a demo — which of two prepared regions
 * to run it in. The region is last on purpose: it is not a question the
 * product has, and putting it first would teach people that Spokes is a tool
 * for two neighbourhoods.
 *
 * Nothing here names a domain (CLAUDE.md §1). Every class label, step title
 * and count is server data; the only words this file owns are in COPY.
 */

const NAME_KEY = "spokesName";

/** Only ever shown if the server told us nothing at all about its classes;
 * the label normally arrives with the areas, like every other class label. */
const DEFAULT_CLASS_LABEL = "somewhere to eat";

interface Props {
  onOpen(inviteSecret: string): void;
  /** Present when this was reached from the landing page. */
  onBack?(): void;
}

/** A step as the screen holds it: the server's, plus what the person edited. */
interface DraftStep {
  stepId: string;
  title: string;
  placeClass: string;
  classLabel: string;
  needs: ParsedNeed[];
  when: PlanStepView["when"];
}

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage refused; the field is still filled for this page */
  }
}

/** The zone the organizer is actually in, so "tonight" means tonight. */
function localZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function toDraft(step: PlanStepView): DraftStep {
  return {
    stepId: step.stepId,
    title: step.title,
    placeClass: step.placeClass.key,
    classLabel: step.placeClass.label,
    needs: step.needs,
    when: step.when,
  };
}

/** Every class the server knows, for the picker on a step. */
function classOptions(
  fromPlan: StepClassSummary[],
  areas: AreaSummary[] | null,
): StepClassSummary[] {
  if (fromPlan.length > 0) return fromPlan;
  const merged = new Map<string, StepClassSummary>();
  for (const area of areas ?? []) {
    for (const item of area.classes ?? []) {
      // Before a region is chosen a count would be a count of somewhere in
      // particular, which this screen deliberately does not know yet.
      if (!merged.has(item.key)) merged.set(item.key, { ...item, count: 0 });
    }
  }
  return [...merged.values()];
}

function RemoveMark() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 7h8" /></svg>;
}

function StepBox({
  step,
  index,
  total,
  classes,
  onClassChange,
  onDropNeed,
  onRemove,
}: {
  step: DraftStep;
  index: number;
  total: number;
  classes: StepClassSummary[];
  onClassChange(key: string): void;
  onDropNeed(need: ParsedNeed): void;
  onRemove(): void;
}) {
  return (
    <li className="step-box card" data-testid={`plan-step-${step.stepId}`}>
      <header className="step-box-head">
        <div className="step-box-order">
          <span className="step-box-index">{COPY.planStepOf(index + 1, total)}</span>
          {index > 0 && <span className="step-box-relation">{COPY.planThen}</span>}
        </div>
        {total > 1 && (
          <button
            type="button"
            className="btn-text onboarding-edit step-box-drop"
            data-testid={`plan-step-remove-${step.stepId}`}
            onClick={onRemove}
          >
            <RemoveMark />
            {COPY.planDropStep}
          </button>
        )}
      </header>

      <p className="step-box-title">{step.title}</p>

      <label className="step-box-field">
        <span>{COPY.planStepClass}</span>
        <select
          value={step.placeClass}
          data-testid={`plan-step-class-${step.stepId}`}
          onChange={(event) => onClassChange(event.target.value)}
        >
          {classes.map((item) => (
            <option value={item.key} key={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      {step.when && <p className="step-box-when">{step.when.phrase}</p>}

      <p className="step-box-kicker">{COPY.planStepNeeds}</p>
      {step.needs.length === 0 ? (
        <p className="step-box-empty">{COPY.planNoNeeds}</p>
      ) : (
        <ul className="step-box-needs">
          {step.needs.map((need) => (
            <li key={`${need.gist}:${need.label}`} className="step-need">
              <span className="mark" aria-hidden="true" />
              <span className="step-need-label">
                {need.label}
                {need.assumed && <span className="step-need-assumed"> {need.assumed}</span>}
              </span>
              <button
                type="button"
                className="btn-text onboarding-edit step-need-drop"
                onClick={() => onDropNeed(need)}
              >
                <RemoveMark />
                {COPY.startDropNeed}
                <span className="sr-only"> {need.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Clarify({
  clarify,
  onApply,
  onSay,
}: {
  clarify: PlanClarification;
  onApply(needs: ParsedNeed[]): void;
  onSay(words: string): void;
}) {
  const many = clarify.mode === "many";
  const [picked, setPicked] = useState<string[]>([]);
  const [words, setWords] = useState("");

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  return (
    <section className="clarify card" data-testid="plan-clarify">
      <p className="clarify-question">{clarify.question}</p>
      <p className="clarify-mode">{many ? COPY.clarifyPickAny : COPY.clarifyPickOne}</p>
      <ul className="clarify-choices">
        {clarify.choices.map((choice) => (
          <li key={choice.id}>
            {many ? (
              <label className="clarify-check">
                <input
                  type="checkbox"
                  checked={picked.includes(choice.id)}
                  data-testid={`plan-clarify-${choice.id}`}
                  onChange={() => toggle(choice.id)}
                />
                <span>{choice.label}</span>
              </label>
            ) : (
              <button
                type="button"
                className="btn onboarding-secondary clarify-choice"
                data-testid={`plan-clarify-${choice.id}`}
                onClick={() => onApply(choice.needs)}
              >
                {choice.label}
              </button>
            )}
          </li>
        ))}
      </ul>
      {many && (
        <button
          type="button"
          className="btn onboarding-secondary clarify-apply"
          data-testid="plan-clarify-apply"
          disabled={picked.length === 0}
          onClick={() =>
            onApply(
              clarify.choices
                .filter((choice) => picked.includes(choice.id))
                .flatMap((choice) => choice.needs),
            )
          }
        >
          {COPY.clarifyApply}
        </button>
      )}
      <label className="clarify-free">
        <span>{COPY.startClarifyFree}</span>
        <input
          value={words}
          data-testid="plan-clarify-words"
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && words.trim()) onSay(words.trim());
          }}
        />
      </label>
    </section>
  );
}

export function Onboarding({ onOpen, onBack }: Props) {
  const [phase, setPhase] = useState<"ask" | "plan">("ask");
  const [name, setName] = useState(rememberedName);
  const [goal, setGoal] = useState("");
  const [areas, setAreas] = useState<AreaSummary[] | null>(null);
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [planClasses, setPlanClasses] = useState<StepClassSummary[]>([]);
  const [clarify, setClarify] = useState<PlanClarification | null>(null);
  const [offline, setOffline] = useState(false);
  const [reading, setReading] = useState(false);
  const [regionOpen, setRegionOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [example, setExample] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchAreas()
      .then((list) => {
        if (!cancelled) setAreas(list);
      })
      .catch(() => {
        /* the region dialog says so when it opens with nothing */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The placeholder cycles through the published examples, so the field
  // teaches the shape of a goal without a paragraph explaining it.
  useEffect(() => {
    if (phase !== "ask") return;
    const timer = window.setInterval(
      () => setExample((current) => (current + 1) % COPY.goalExamples.length),
      4200,
    );
    return () => window.clearInterval(timer);
  }, [phase]);

  // A read can take a while; changing the goal supersedes one in flight so a
  // stale answer cannot land as the plan.
  const readSeq = useRef(0);

  const read = async (words: string, retained: ParsedNeed[] = []) => {
    const seq = ++readSeq.current;
    setReading(true);
    setError(null);
    const zone = localZone();
    const preview = await previewPlan({
      goal: words,
      ...(zone ? { timezone: zone } : {}),
    });
    if (seq !== readSeq.current) return;
    setReading(false);
    if (!preview || preview.steps.length === 0) {
      setOffline(true);
      setPlanClasses([]);
      // Nobody could read the words, so the step is named after the kind of
      // place it is — which is server data, and follows the picker from here.
      const fallback = classOptions([], areas).find((item) => item.key === "food");
      setSteps([
        {
          stepId: "s1",
          title: fallback?.label ?? DEFAULT_CLASS_LABEL,
          placeClass: fallback?.key ?? "food",
          classLabel: fallback?.label ?? DEFAULT_CLASS_LABEL,
          needs: retained,
          when: null,
        },
      ]);
      setClarify(null);
      setPhase("plan");
      return;
    }
    setOffline(preview.offline);
    setPlanClasses(preview.classes);
    setSteps(
      preview.steps.map((step, index) => {
        const draft = toDraft(step);
        // Answers to a clarification are kept when the goal is re-read, and
        // they belong to the step they were given for.
        return index === 0 ? { ...draft, needs: [...retained, ...draft.needs] } : draft;
      }),
    );
    setClarify(preview.clarify);
    setPhase("plan");
  };

  const open = async (areaId: string) => {
    setOpening(true);
    setError(null);
    const result = await createRoom({
      areaId,
      organizerName: name.trim(),
      goal: goal.trim(),
      steps: steps.map((step) => ({
        placeClass: step.placeClass,
        ...(step.title ? { title: step.title } : {}),
        ...(step.needs.length ? { needs: step.needs } : {}),
        ...(step.when ? { when: step.when } : {}),
      })),
    });
    setOpening(false);
    if (!result.ok) {
      setRegionOpen(false);
      setError(result.error);
      return;
    }
    rememberName(name.trim());
    const room: CreatedRoom = result.room;
    const organizer = room.invites.find((invite) => invite.role === "organizer");
    if (!organizer) {
      setError("The room opened without a way in. Try again.");
      return;
    }
    onOpen(organizer.inviteSecret);
  };

  const classes = classOptions(planClasses, areas);

  if (phase === "ask") {
    const ready = name.trim().length > 0 && goal.trim().length > 0;
    return (
      <div className="start" data-testid="start">
        <Wordmark />
        <form
          className="ask"
          data-testid="onboarding-ask"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !reading) void read(goal.trim());
          }}
        >
          <label className="ask-field">
            <span>{COPY.askName}</span>
            <input
              value={name}
              data-testid="ask-name"
              autoComplete="given-name"
              placeholder={COPY.askNamePlaceholder}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label className="ask-field ask-goal">
            <span>{COPY.askGoal}</span>
            <textarea
              value={goal}
              data-testid="ask-goal"
              rows={3}
              maxLength={300}
              placeholder={COPY.goalExamples[example]}
              onChange={(event) => {
                // A read already in flight was about the old words. Retire it
                // here, or its answer can land as the plan for these ones.
                readSeq.current += 1;
                setReading(false);
                setGoal(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && ready) {
                  event.preventDefault();
                  void read(goal.trim());
                }
              }}
            />
            <span className="ask-help">{COPY.askGoalHelp}</span>
          </label>

          {error && <p className="start-error" role="alert">{error}</p>}

          <div className="ask-actions">
            {onBack && (
              <button type="button" className="btn onboarding-secondary ask-back" data-testid="start-back" onClick={onBack}>
                Back
              </button>
            )}
            <button
              type="submit"
              className="ask-go"
              data-testid="ask-continue"
              disabled={!ready || reading}
            >
              {reading ? COPY.planReading : COPY.goalContinue}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="start" data-testid="start" data-phase="plan">
      <Wordmark />
      <p className="plan-kicker" data-testid="onboarding-plan">{COPY.planKicker}</p>
      <p className="plan-goal" data-testid="plan-goal">{goal.trim()}</p>
      <p className="plan-count" data-testid="plan-count">
        {steps.length === 1 ? COPY.planOneStep : COPY.planSteps(steps.length)}
      </p>
      {offline && <p className="plan-offline">{COPY.planOffline}</p>}

      <ol className="step-boxes">
        {steps.map((step, index) => (
          <StepBox
            key={step.stepId}
            step={step}
            index={index}
            total={steps.length}
            classes={classes}
            onClassChange={(key) =>
              setSteps((current) =>
                current.map((row) => {
                  if (row.stepId !== step.stepId) return row;
                  const label = classes.find((item) => item.key === key)?.label ?? row.classLabel;
                  return {
                    ...row,
                    placeClass: key,
                    classLabel: label,
                    // A title the goal did not supply is just the class label,
                    // and must follow the class. One the sentence DID supply
                    // is the person's own words and stays theirs.
                    title: row.title === row.classLabel ? label : row.title,
                  };
                }),
              )
            }
            onDropNeed={(need) =>
              setSteps((current) =>
                current.map((row) =>
                  row.stepId === step.stepId
                    ? { ...row, needs: row.needs.filter((item) => item !== need) }
                    : row,
                ),
              )
            }
            onRemove={() =>
              setSteps((current) => current.filter((row) => row.stepId !== step.stepId))
            }
          />
        ))}
      </ol>

      {clarify && (
        <Clarify
          clarify={clarify}
          onApply={(needs) => {
            const stepId = clarify.stepId ?? steps[0]?.stepId;
            setSteps((current) =>
              current.map((row) =>
                row.stepId === stepId ? { ...row, needs: [...row.needs, ...needs] } : row,
              ),
            );
            setClarify(null);
          }}
          onSay={(words) => {
            const retained = steps[0]?.needs ?? [];
            setClarify(null);
            void read(`${goal.trim()} ${words}`.slice(0, 300), retained);
          }}
        />
      )}

      {error && <p className="start-error" role="alert">{error}</p>}

      <div className="plan-actions">
        <button
          type="button"
          className="btn onboarding-secondary plan-back"
          data-testid="plan-back"
          onClick={() => setPhase("ask")}
        >
          {COPY.planBack}
        </button>
        <button
          type="button"
          className="plan-confirm"
          data-testid="plan-confirm"
          disabled={steps.length === 0 || reading}
          onClick={() => setRegionOpen(true)}
        >
          {COPY.planConfirm}
        </button>
      </div>

      {regionOpen && (
        <RegionDialog
          areas={areas}
          steps={steps.map((step) => ({ placeClass: step.placeClass }))}
          busy={opening}
          onPick={(areaId) => void open(areaId)}
          onClose={() => setRegionOpen(false)}
        />
      )}
    </div>
  );
}
