"use client";

import { checkOpenRouterKey } from "@invisible-dots/shared/browser";
import { CircleCheckIcon, CircleXIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { keySavedMessage } from "../../lib/host-settings";
import { ErrorAlert } from "../ErrorAlert";
import { Field } from "../new-dot/Field";
import { useHealth } from "../shell/attention";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useAction } from "../ui";

/**
 * The OpenRouter key every Dot's model requests are paid with. The field is write-only: the key goes to the control
 * plane, which keeps it encrypted, and nothing ever sends it back, so whether it is stored comes from the health
 * answer, and the answer to saving one says how many running Dots were given it at once.
 */
export function KeyForm() {
  const health = useHealth();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useAction();
  const configured = health.data?.openrouter_configured;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checked = checkOpenRouterKey(value);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    setProblem(null);
    setSaved(null);
    await save.run(async () => {
      const { pushed } = await api.setOpenRouterKey(checked.key);
      setValue("");
      setSaved(keySavedMessage(pushed));
      health.reload();
    });
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      {configured !== undefined ? (
        <p className="flex items-center gap-1.5 text-sm" role="status">
          {configured ? <CircleCheckIcon aria-hidden="true" className="size-4 text-ok" /> : <CircleXIcon aria-hidden="true" className="size-4 text-danger" />}
          {configured ? "A key is stored." : "No key is stored."}
        </p>
      ) : null}
      <Field
        id="openrouter-key"
        label={configured ? "Replace the key" : "OpenRouter API key"}
        hint={
          <>
            Stored encrypted by the control plane and never shown again. Create one at{" "}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              openrouter.ai/keys
            </a>
            .
          </>
        }
        error={problem}
      >
        {(control) => (
          <Input
            {...control}
            name="openrouter-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-or-..."
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setProblem(null);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={save.pending || value.trim() === ""}>
          {save.pending ? "Saving..." : configured ? "Replace key" : "Save key"}
        </Button>
        {saved ? (
          <p role="status" className="text-sm text-ok">
            {saved}
          </p>
        ) : null}
      </div>
      {save.error ? <ErrorAlert error={save.error} title="Could not save the key" /> : null}
    </form>
  );
}
